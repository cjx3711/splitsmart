/**
 * The sync loop.
 *
 * RECEIVE THEN SEND, in that order, every cycle:
 *
 *   pull(cursor) -> apply -> advance cursor -> push(outbox) -> per-op results
 *
 * The order matters. Pulling first means an arriving change cannot be overwritten
 * by a queued write that was made before it, and it is what lets the reducer's
 * delete-wins rule fire before we push an edit onto somebody else's deletion.
 *
 * SINGLE-FLIGHT. One cycle at a time, ever. Four triggers can fire at once - the
 * tab coming to the foreground, `online`, the interval, a manual Sync now - and
 * without this they would stack into a retry storm against a server that is
 * already struggling, which is exactly when they all fire together.
 *
 * The policy this file obeys but does not own: web/src/sync/outbox.ts decides what
 * a queued write becomes and whether a pulled change may overwrite it. Keeping
 * that pure and keeping this imperative is deliberate - the decisions are the part
 * worth testing without a browser.
 */
import { computeSplit, type SplitType } from "../../../src/domain/split.ts";
import {
  isRepeatInterval,
  nextOccurrenceOnOrAfter,
} from "../../../src/domain/recurring.ts";
import {
  api,
  ApiError,
  type PullChange,
  type PushOpWire,
  type PushResultWire,
} from "../api.ts";
import {
  applyBootstrapPage,
  applyUserMerge,
  dropFriendship,
  forgetExpense,
  forgetGroupExpenses,
  markExpense,
  putComments,
  putExpenses,
  putFriendships,
  putGroupMembers,
  putGroups,
  putReferenceData,
  putUsers,
} from "../db/apply.ts";
import {
  getMeta,
  setMeta,
  type LocalComment,
  type LocalDb,
  type LocalExpense,
  type OutboxOp,
  type SyncComment,
  type SyncExpense,
  type SyncFriendship,
  type SyncGroup,
  type SyncGroupMember,
  type SyncUser,
} from "../db/local.ts";
import {
  reconcileRemote,
  reduceOutbox,
  sortForPush,
  type LocalWrite,
  type RemoteEvent,
} from "./outbox.ts";

/** How often a quiet, foregrounded tab checks in. A bill is not urgent to the minute. */
export const SYNC_INTERVAL_MS = 300_000;

/** Ops per push request. The server caps at 200; a full queue drains in batches. */
const PUSH_BATCH = 100;

/**
 * Pages drained per cycle, as a runaway guard rather than a real limit.
 *
 * A pull page is a thousand rows and `more` is drained within the cycle, not one
 * page per tick - a client that takes a page every five minutes is not syncing, it
 * is trickling. The cap exists so a server bug that never advances `seq` cannot
 * spin here forever.
 */
const MAX_PAGES = 50;

export interface SyncStatus {
  /** `navigator.onLine` plus whether the last attempt actually reached the server. */
  online: boolean;
  syncing: boolean;
  /** Writes waiting to go out. */
  pending: number;
  /** Writes overtaken by somebody else's edit, waiting on a person. */
  conflicts: number;
  /** Writes the server refused. Quarantined, never silently dropped. */
  rejected: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  bootstrapped: boolean;
}

export class SyncEngine {
  readonly db: LocalDb;
  readonly selfId: string;

  private inFlight: Promise<void> | null = null;
  private listeners = new Set<() => void>();

  constructor(db: LocalDb, selfId: string) {
    this.db = db;
    this.selfId = selfId;
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private announce(): void {
    for (const listener of this.listeners) listener();
  }

  async status(): Promise<SyncStatus> {
    const queued = await this.db.outbox.toArray();
    return {
      online: navigator.onLine,
      syncing: this.inFlight !== null,
      pending: queued.filter((op) => op.status === "pending").length,
      conflicts: queued.filter((op) => op.status === "conflict").length,
      rejected: queued.filter((op) => op.status === "rejected").length,
      lastSyncedAt: (await getMeta(this.db, "lastSyncedAt")) ?? null,
      lastError: (await getMeta(this.db, "lastError")) ?? null,
      bootstrapped: (await getMeta(this.db, "bootstrapped")) ?? false,
    };
  }

  // -------------------------------------------------------------------------
  // The cycle
  // -------------------------------------------------------------------------

  /**
   * Runs one full cycle, or joins the one already running.
   *
   * Never rejects. A sync failure is a status, not an exception: it happens every
   * time the network drops, which offline-first treats as the normal case rather
   * than an error to propagate into a render.
   */
  sync(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.run()
      .catch(async (err: unknown) => {
        await setMeta(this.db, "lastError", describeError(err));
      })
      .finally(() => {
        this.inFlight = null;
        this.announce();
      });

    this.announce();
    return this.inFlight;
  }

  private async run(): Promise<void> {
    if (!(await getMeta(this.db, "bootstrapped"))) await this.bootstrap();

    await this.pullAll();
    const pushed = await this.pushAll();

    // One more pull when something landed: the server's own copy of what we just
    // wrote, plus the system comments its edits generated. Those have seqs above
    // our cursor, so they are cheap to fetch and the alternative is a thread that
    // looks incomplete until the next tick.
    if (pushed) await this.pullAll();

    await setMeta(this.db, "lastSyncedAt", new Date().toISOString());
    await setMeta(this.db, "lastError", null);
  }

  /**
   * Empties the local ledger and bootstraps again.
   *
   * Used after the server wiped this account's data. Pull cannot reconstruct a
   * deleted history, so the mirror has to start over. The cached profile stays
   * so a reload still knows who is signed in.
   */
  async resetMirror(): Promise<void> {
    if (this.inFlight) await this.inFlight;
    const profile = await getMeta(this.db, "profile");
    await this.db.transaction("rw", this.db.tables, async () => {
      await Promise.all(this.db.tables.map((table) => table.clear()));
    });
    if (profile) await setMeta(this.db, "profile", profile);
    await setMeta(this.db, "bootstrapped", false);
    await setMeta(this.db, "cursor", 0);
    await this.sync();
  }

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  /**
   * Fetches everything visible, for a fresh install or a reset mirror.
   *
   * The cursor is the `seq` from the FIRST page and is written only once every
   * page has drained. Writing each page's own `seq` would move the cursor past
   * changes that later pages have not delivered yet; leaving it at the first
   * page's value means a change may arrive twice, and a whole-entity upsert
   * applied twice is a no-op.
   */
  private async bootstrap(): Promise<void> {
    let cursor: string | null = null;
    let firstSeq: number | null = null;
    let pages = 0;

    for (;;) {
      const page = await api.syncBootstrap(cursor);
      if (firstSeq === null) firstSeq = page.seq;

      await applyBootstrapPage(this.db, page);
      this.announce();

      cursor = page.nextCursor;
      if (cursor === null) break;
      if (++pages > MAX_PAGES) break;
    }

    await setMeta(this.db, "cursor", firstSeq ?? 0);
    await setMeta(this.db, "bootstrapped", true);
  }

  // -------------------------------------------------------------------------
  // Pull
  // -------------------------------------------------------------------------

  /** Drains `more` and any `catchUp` within this cycle. */
  private async pullAll(): Promise<void> {
    for (let page = 0; page < MAX_PAGES; page++) {
      const since = (await getMeta(this.db, "cursor")) ?? 0;
      const response = await api.syncPull(since);

      for (const change of response.changes) await this.applyChange(change);

      // Advanced even when nothing applied: the rows were delivered, and asking
      // for them again forever is how a client gets stuck on one bad page.
      if (response.seq > since) await setMeta(this.db, "cursor", response.seq);

      // Access granted since we last synced. `since` is NOT rewound - the history
      // being fetched is all below the cursor by definition, which is the entire
      // reason a snapshot exists rather than a re-bootstrap.
      for (const target of response.catchUp) {
        const snapshot =
          target.entity === "group"
            ? await api.syncSnapshotGroup(target.id)
            : await api.syncSnapshotExpense(target.id);

        await putGroups(this.db, snapshot.groups ?? []);
        await putGroupMembers(this.db, snapshot.members ?? []);
        await putExpenses(this.db, snapshot.expenses ?? []);
        await putComments(this.db, snapshot.comments ?? []);
      }

      this.announce();
      if (!response.more) return;
    }
  }

  /** The queued op for an entity, if any. One per entity, by the reducer's rule. */
  private pendingFor(id: string): Promise<OutboxOp | undefined> {
    return this.db.outbox.where("id").equals(id).first();
  }

  private async applyChange(change: PullChange): Promise<void> {
    switch (change.entity) {
      case "user_merge":
        return this.applyMerge(change.data as { fromUserId: string; toUserId: string });

      case "expense":
        return this.applyExpenseChange(change);

      case "comment":
        return this.applyCommentChange(change);

      case "group":
        return putGroups(this.db, [change.data as SyncGroup]);

      case "group_member":
        return this.applyMemberChange(change.data as SyncGroupMember);

      case "friendship": {
        if (change.op === "delete") {
          const pair = change.data as { userAId: string; userBId: string };
          return dropFriendship(this.db, pair.userAId, pair.userBId);
        }
        return putFriendships(this.db, [change.data as SyncFriendship]);
      }

      case "user": {
        const user = change.data as SyncUser;
        await putUsers(this.db, [user]);
        // Your own row is also the cached profile the app boots from.
        if (user.id === this.selfId) await setMeta(this.db, "profile", user);
        return;
      }
    }
  }

  private async applyExpenseChange(change: PullChange): Promise<void> {
    const id = (change.data as { id: string }).id;
    const pending = await this.pendingFor(id);

    const remote: RemoteEvent =
      change.op === "forget"
        ? { type: "forget" }
        : change.op === "delete"
          ? { type: "delete" }
          : { type: "upsert" };

    const decision = reconcileRemote(pending, remote);

    if (remote.type === "forget") {
      // Drops the row, its thread and anything queued for it, together.
      await forgetExpense(this.db, id);
      return;
    }

    if (decision.applyRemote) await putExpenses(this.db, [change.data as SyncExpense]);

    if (decision.conflict) {
      const server = change.data as SyncExpense;
      await markExpense(this.db, id, { syncState: "conflict", conflictWith: server });
      if (pending?.seq !== undefined) {
        await this.db.outbox.update(pending.seq, {
          status: "conflict",
          reason: "Somebody else brought this expense back while your delete was waiting.",
        });
      }
      return;
    }

    if (!decision.keepPending && pending?.seq !== undefined) {
      await this.db.outbox.delete(pending.seq);
    }
  }

  private async applyCommentChange(change: PullChange): Promise<void> {
    const comment = change.data as SyncComment;
    const pending = await this.pendingFor(comment.id);

    // A deleted comment is simply gone from the thread. Unlike an expense there is
    // no tombstone worth keeping: there is no undo, and nothing derives from it.
    if (change.op === "delete" || change.op === "forget" || comment.deletedAt !== null) {
      await this.db.comments.delete(comment.id);
      if (pending?.seq !== undefined) await this.db.outbox.delete(pending.seq);
      return;
    }

    // A pending local create echoing back: leave the local row alone until push
    // confirms, so its `pending` badge does not flicker off and on.
    if (pending?.kind === "comment.create") return;

    await putComments(this.db, [comment]);
  }

  private async applyMemberChange(member: SyncGroupMember): Promise<void> {
    await putGroupMembers(this.db, [member]);

    // You have left. Drop the group's expenses you are not a participant of, and
    // keep the ones you are: the same rule the All Expenses screen has always
    // used, because somebody still owes you for that dinner.
    if (member.userId === this.selfId && member.leftAt !== null) {
      await forgetGroupExpenses(this.db, member.groupId, this.selfId);
    }
  }

  /**
   * A claim happened: a ghost is now an account.
   *
   * Remap rather than wipe. A wipe would destroy the outbox - the only copy of an
   * unsynced dinner - plus conflict and quarantine state, and it would fire on the
   * owner's other laptop merely because somebody claimed a placeholder they had
   * created. Anything the remap cannot do cleanly is quarantined for a person,
   * never guessed at: combining two people's shares is the server's job.
   */
  private async applyMerge(merge: { fromUserId: string; toUserId: string }): Promise<void> {
    const unmappable = await applyUserMerge(this.db, merge.fromUserId, merge.toUserId);

    for (const seq of unmappable) {
      await this.db.outbox.update(seq, {
        status: "rejected",
        reason:
          "This names the same person twice now that a placeholder has been claimed. Please re-enter it.",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Push
  // -------------------------------------------------------------------------

  /** Sends the queue. Returns whether anything was accepted. */
  private async pushAll(): Promise<boolean> {
    const queued = sortForPush(
      await this.db.outbox.where("status").equals("pending").toArray(),
    );
    if (queued.length === 0) return false;

    let accepted = false;

    for (let i = 0; i < queued.length; i += PUSH_BATCH) {
      const batch = queued.slice(i, i + PUSH_BATCH);
      const { results } = await api.syncPush(batch.map(toWireOp));

      const bySeq = new Map(batch.map((op) => [op.id, op]));
      for (const result of results) {
        const op = bySeq.get(result.id);
        if (!op) continue;
        if (await this.applyPushResult(op, result)) accepted = true;
      }

      this.announce();
    }

    return accepted;
  }

  /**
   * Records one op's outcome.
   *
   * ONLY EVER on a parsed, per-op `status`. Never on an HTTP 200 alone: a 200
   * carrying four results of which one is a conflict is a successful request and a
   * failed write, and clearing the queue on the response code would throw that
   * write away. Learned from DumberTime's bug list.
   */
  private async applyPushResult(op: OutboxOp, result: PushResultWire): Promise<boolean> {
    const isComment = op.kind.startsWith("comment.");

    switch (result.status) {
      case "applied": {
        if (op.seq !== undefined) await this.db.outbox.delete(op.seq);
        if (!isComment) {
          // Adopt the new version immediately. Waiting for the echo pull would
          // leave a window where a second local edit still carries the old
          // baseVersion and conflicts with this device's own write.
          const existing = await this.db.expenses.get(op.id);
          if (existing) {
            await this.db.expenses.put({
              ...existing,
              version: result.version ?? existing.version,
              syncState: "synced",
              conflictWith: null,
              rejectedReason: null,
            });
          }
        }
        return true;
      }

      case "duplicate": {
        // Our write had already landed and the answer went missing. Adopt the
        // stored row: our copy may differ from it, and the server's is the one
        // that counts.
        if (op.seq !== undefined) await this.db.outbox.delete(op.seq);
        if (result.server && !isComment) {
          await putExpenses(this.db, [result.server as unknown as SyncExpense]);
        } else if (result.server) {
          await putComments(this.db, [result.server as unknown as SyncComment]);
        }
        return true;
      }

      case "conflict": {
        // Stays in the queue, in a conflict state, not the bin. "Keep both" is a
        // UI affordance; applying both versions would double the money.
        if (op.seq !== undefined) {
          await this.db.outbox.update(op.seq, {
            status: "conflict",
            reason: result.reason ?? "Somebody else changed this while your edit was waiting.",
          });
        }
        await markExpense(this.db, op.id, {
          syncState: "conflict",
          conflictWith: (result.server as unknown as SyncExpense | undefined) ?? null,
        });
        return false;
      }

      case "rejected": {
        // Quarantine, visible. The same discipline as the importer's `skipped[]`:
        // an expense that silently vanishes between devices is worse than an error.
        if (op.seq !== undefined) {
          await this.db.outbox.update(op.seq, {
            status: "rejected",
            reason: result.reason ?? "The server could not apply this.",
          });
        }
        if (!isComment) {
          await markExpense(this.db, op.id, {
            syncState: "rejected",
            rejectedReason: result.reason ?? "The server could not apply this.",
          });
        }
        return false;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Queueing a local write
  // -------------------------------------------------------------------------

  /**
   * Records a write locally and queues it for the server.
   *
   * The local effect is applied in the SAME transaction as the queue entry, so a
   * bill can never be visible without being queued, or queued without being
   * visible. The split is computed with the real `computeSplit` - the frontend
   * already imports it for the editor's preview - so the provisional row shows the
   * same cents the server will store. The server still recomputes on replay and
   * remains authoritative.
   */
  async enqueue(write: LocalWrite): Promise<void> {
    const queuedAt = new Date().toISOString();

    await this.db.transaction(
      "rw",
      this.db.outbox,
      this.db.expenses,
      this.db.comments,
      this.db.users,
      async () => {
      const pending = await this.db.outbox.where("id").equals(write.id).first();
      const decision = reduceOutbox(pending, write, queuedAt);

      if (decision.action === "ignore") throw new Error(decision.reason);

      if (decision.action === "drop") {
        if (pending?.seq !== undefined) await this.db.outbox.delete(pending.seq);
      } else if (decision.action === "replace" && pending?.seq !== undefined) {
        await this.db.outbox.put({ ...decision.entry, seq: pending.seq });
      } else {
        await this.db.outbox.add(decision.entry as OutboxOp);
      }

      await this.applyLocally(write, decision.action === "drop");
    });

    this.announce();
    // Best-effort: offline this fails and the queue simply waits.
    void this.sync();
  }

  /** The optimistic local effect of a write. */
  private async applyLocally(write: LocalWrite, dropped: boolean): Promise<void> {
    switch (write.kind) {
      case "expense.create":
      case "payment.create": {
        const existing = await this.db.expenses.get(write.id);
        await this.db.expenses.put(
          await this.provisionalExpense(write.id, write.payload, {
            isPayment: write.kind === "payment.create",
            base: existing,
          }),
        );
        return;
      }

      case "expense.update": {
        const existing = await this.db.expenses.get(write.id);
        if (!existing) return;
        await this.db.expenses.put(
          await this.provisionalExpense(write.id, write.payload, {
            isPayment: existing.isPayment,
            base: existing,
          }),
        );
        return;
      }

      case "expense.delete":
        // A local tombstone. The undo is on the expense page and works offline,
        // which is why this is a flag rather than a removal.
        await markExpenseDeleted(this.db, write.id, new Date().toISOString(), dropped);
        return;

      case "expense.restore":
        await markExpenseDeleted(this.db, write.id, null, dropped);
        return;

      case "comment.create": {
        const author = (await this.db.users.get(this.selfId)) ?? null;
        const comment: LocalComment = {
          id: write.id,
          expenseId: write.payload.expenseId,
          userId: this.selfId,
          kind: "user",
          content: write.payload.content,
          createdAt: new Date().toISOString(),
          deletedAt: null,
          author,
          syncState: dropped ? "synced" : "pending",
        };
        await this.db.comments.put(comment);
        return;
      }

      case "comment.delete":
        await this.db.comments.delete(write.id);
        return;
    }
  }

  /**
   * A provisional expense document, split computed locally.
   *
   * `version` comes from the row already in the mirror, never from a local
   * increment: it is the version the SERVER last confirmed, which is what an edit
   * has to send back as `baseVersion`. Bumping it here would make the conflict
   * check compare a number nobody has ever stored.
   */
  private async provisionalExpense(
    id: string,
    payload: {
      groupId?: string | null;
      description: string;
      details?: string | null;
      costMinor: number;
      currencyCode: string;
      date: string;
      categoryId?: number | null;
      splitType: string;
      participants: Array<{ userId: string; paidMinor: number; input?: number }>;
      items?: unknown;
      taxMinor?: number;
      tipMinor?: number;
      repeatInterval?: string | null;
      paymentMethod?: string | null;
    },
    options: { isPayment: boolean; base?: LocalExpense },
  ): Promise<LocalExpense> {
    const shares = computeSplit(
      payload.costMinor,
      payload.splitType as SplitType,
      payload.participants,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- items are validated by the form and re-validated by the server
      { items: payload.items as any },
    );

    const people = (await this.db.users.bulkGet(shares.map((s) => s.userId))).filter(
      (u): u is SyncUser => u !== undefined,
    );

    const now = new Date().toISOString();

    return {
      id,
      groupId: payload.groupId ?? null,
      description: payload.description,
      details: payload.details ?? null,
      costMinor: payload.costMinor,
      currencyCode: payload.currencyCode,
      date: payload.date,
      categoryId: payload.categoryId ?? null,
      splitType: payload.splitType,
      // Stored so an unsynced itemized bill reopens with the same lines. The
      // server recomputes this blob on replay; matching its shape here is what
      // lets the editor reconstruct the form before that happens.
      splitMeta: provisionalSplitMeta(payload) ?? options.base?.splitMeta ?? null,
      isPayment: options.isPayment,
      paymentMethod: payload.paymentMethod ?? options.base?.paymentMethod ?? null,
      // Recurrence is server-owned for `next_repeat`, but an explicit
      // `repeatInterval` on the write is a decision this device just made and
      // has to show immediately: otherwise Stop repeating looks like a no-op
      // until the next pull. Resume computes the next date the same way the
      // server will, so the note is not blank until pull.
      repeatInterval:
        payload.repeatInterval !== undefined
          ? payload.repeatInterval
          : (options.base?.repeatInterval ?? null),
      nextRepeat:
        payload.repeatInterval === null
          ? null
          : payload.repeatInterval !== undefined &&
              (payload.repeatInterval !== options.base?.repeatInterval ||
                payload.date !== options.base?.date)
            ? isRepeatInterval(payload.repeatInterval) && options.base?.repeatPaused
              ? nextOccurrenceOnOrAfter(payload.date, payload.repeatInterval)
              : null
            : (options.base?.nextRepeat ?? null),
      repeatOf: options.base?.repeatOf ?? null,
      repeatPaused:
        payload.repeatInterval === null
          ? (isRepeatInterval(options.base?.repeatInterval)
              ? options.base.repeatInterval
              : (options.base?.repeatPaused ?? null))
          : payload.repeatInterval !== undefined
            ? null
            : (options.base?.repeatPaused ?? null),
      version: options.base?.version ?? 1,
      createdBy: options.base?.createdBy ?? this.selfId,
      updatedBy: this.selfId,
      createdAt: options.base?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      shares: shares.map((s) => ({
        userId: s.userId,
        paidShareMinor: s.paidMinor,
        owedShareMinor: s.owedMinor,
        splitInput: s.input ?? null,
      })),
      people,
      syncState: "pending",
      conflictWith: null,
      rejectedReason: null,
    };
  }

  // -------------------------------------------------------------------------
  // Conflict and quarantine resolution
  // -------------------------------------------------------------------------

  /**
   * Discards a queued write and keeps the server's row.
   *
   * The only resolution that needs no new write. Its opposite - "mine wins" - is
   * `retry`, which re-bases the queued op on the version the server has now.
   */
  async discard(entrySeq: number): Promise<void> {
    const op = await this.db.outbox.get(entrySeq);
    if (!op) return;

    await this.db.outbox.delete(entrySeq);
    if (!op.kind.startsWith("comment.")) {
      const server = (await this.db.expenses.get(op.id))?.conflictWith ?? null;
      if (server) await putExpenses(this.db, [server]);
      else await markExpense(this.db, op.id, { syncState: "synced", conflictWith: null });
    }
    this.announce();
    void this.sync();
  }

  /**
   * Re-bases a conflicted or rejected write on what the server has now, and queues
   * it again.
   *
   * This is "mine wins", and it is a deliberate act by a person rather than
   * something the loop does: the whole point of surfacing a conflict is that only
   * the user knows whether their number or the other one is right.
   */
  async retry(entrySeq: number): Promise<void> {
    const op = await this.db.outbox.get(entrySeq);
    if (!op) return;

    const current = await this.db.expenses.get(op.id);
    const baseVersion = current?.conflictWith?.version ?? current?.version ?? op.baseVersion ?? 1;

    await this.db.outbox.update(entrySeq, {
      status: "pending",
      reason: null,
      baseVersion: op.kind.startsWith("comment.") ? null : baseVersion,
    });
    await markExpense(this.db, op.id, {
      syncState: "pending",
      conflictWith: null,
      rejectedReason: null,
    });

    this.announce();
    void this.sync();
  }

  // -------------------------------------------------------------------------
  // Triggers
  // -------------------------------------------------------------------------

  /**
   * Wires up the four triggers and returns a teardown.
   *
   * Foreground, `online`, an interval, and whatever calls `sync()` by hand. All of
   * them funnel through the single-flight above, so a tab that regains focus at the
   * same moment the network returns runs one cycle, not two.
   */
  start(): () => void {
    const kick = () => void this.sync();

    const onVisible = () => {
      if (document.visibilityState === "visible") kick();
    };

    window.addEventListener("online", kick);
    window.addEventListener("offline", () => this.announce());
    document.addEventListener("visibilitychange", onVisible);
    const timer = window.setInterval(kick, SYNC_INTERVAL_MS);

    kick();

    return () => {
      window.removeEventListener("online", kick);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(timer);
    };
  }
}

// ---------------------------------------------------------------------------

/**
 * The itemized blob, as the editor will reopen it.
 *
 * Matching `serialiseSplitMeta` in src/domain/expenses.ts is load-bearing: that
 * is the only shape `reopenExpense` knows how to read, and a restaurant bill
 * typed offline has to come back with the same lines before the server has
 * confirmed it.
 */
function provisionalSplitMeta(payload: {
  splitType: string;
  items?: unknown;
  taxMinor?: number;
  tipMinor?: number;
}): string | null {
  if (payload.splitType !== "itemized" || !Array.isArray(payload.items) || payload.items.length === 0) {
    return null;
  }
  const tax = payload.taxMinor ?? 0;
  const tip = payload.tipMinor ?? 0;
  return JSON.stringify({
    items: payload.items,
    ...(tax !== 0 ? { taxMinor: tax } : {}),
    ...(tip !== 0 ? { tipMinor: tip } : {}),
  });
}

/**
 * A queue entry, as the wire wants it.
 *
 * `baseVersion` is omitted rather than sent as null when absent: the schema on the
 * other side accepts a positive integer or nothing at all, and "nothing" is what a
 * create and every comment op mean.
 */
function toWireOp(op: OutboxOp): PushOpWire {
  return {
    kind: op.kind,
    id: op.id,
    ...(op.baseVersion === null || op.baseVersion === undefined
      ? {}
      : { baseVersion: op.baseVersion }),
    ...(op.payload === null || op.payload === undefined ? {} : { payload: op.payload }),
  };
}

async function markExpenseDeleted(
  db: LocalDb,
  id: string,
  deletedAt: string | null,
  dropped: boolean,
): Promise<void> {
  const existing = await db.expenses.get(id);
  if (!existing) return;
  await db.expenses.put({
    ...existing,
    deletedAt,
    // A dropped queue entry means the pair cancelled out and the row is back to
    // whatever the server already had.
    syncState: dropped ? "synced" : "pending",
  });
}

/**
 * A failure, as the offline indicator should word it.
 *
 * A 401 is deliberately NOT treated as a logout here. The 30-day session cookie
 * can expire while unsynced expenses are queued, and throwing the queue away
 * because of it would lose them; that is "reconnect to keep syncing", and
 * `Protected` in App.tsx has the matching rule.
 */
function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Signed out on the server. Log in again to keep syncing.";
    return err.message;
  }
  if (err instanceof TypeError) return "No connection.";
  return err instanceof Error ? err.message : "Sync failed.";
}
