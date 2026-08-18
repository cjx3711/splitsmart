/**
 * The outbox reducer, and the pull-versus-pending policy.
 *
 * PURE. No Dexie, no fetch, no React, no clock. That is the point: this is where
 * every offline write decision lives, it is the part of the whole feature most
 * likely to be subtly wrong, and it is testable under `node:test` without a
 * browser (web/src/sync/outbox.test.ts).
 *
 * ONE PENDING OP PER ENTITY. Not a log of everything the user did - a statement
 * of what the server still needs to be told. Editing a bill four times offline
 * pushes once, and the four intermediate states never existed as far as anybody
 * else is concerned.
 *
 * `baseVersion` IS FROZEN AT THE FIRST LOCAL WRITE and never moved again, however
 * many times the user then changes their mind. It means "the version I was
 * looking at when I started", which is the only reading that makes the conflict
 * check answer the right question: an optimistic bump would compare against a
 * version this device never saw the contents of.
 *
 * A create cannot conflict. The primary key is a client-minted ULID, so a retry
 * of the same id is the lost-response case rather than a merge, and the server
 * returns the stored row. Comment creates are the same, and comments have no
 * version at all - they must never touch `expenses.version`, or an offline note
 * would fight an offline edit of the split.
 */
import type { OutboxKind, OutboxOp } from "../db/local.ts";

// ---------------------------------------------------------------------------
// What a local write looks like
// ---------------------------------------------------------------------------

/**
 * The body of an expense write, as `/api/v1/sync/push` will forward it.
 *
 * `repeatInterval` IS THREE-STATE and the distinction is load-bearing: absent
 * leaves an existing schedule alone, `null` stops it, a value sets it. Ordinary
 * edits omit it, because sending the current interval is a *set* - which
 * recomputes `next_repeat` from the date and silently shifts somebody's rent.
 * Only the (online-only) repeat control ever sends one.
 */
export interface ExpenseWritePayload {
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
  isPayment?: boolean;
  paymentMethod?: string | null;
  repeatInterval?: string | null;
}

export interface CommentWritePayload {
  expenseId: string;
  content: string;
}

/** Something the user just did, before it becomes (or joins) a queued op. */
export type LocalWrite =
  | { kind: "expense.create"; id: string; payload: ExpenseWritePayload }
  | { kind: "payment.create"; id: string; payload: ExpenseWritePayload }
  | { kind: "expense.update"; id: string; payload: ExpenseWritePayload; baseVersion: number }
  | { kind: "expense.delete"; id: string; baseVersion: number }
  | { kind: "expense.restore"; id: string; baseVersion: number }
  | { kind: "comment.create"; id: string; payload: CommentWritePayload }
  | { kind: "comment.delete"; id: string };

/**
 * What the caller should do to the queue.
 *
 * `replace` keeps the existing entry's `seq`, deliberately: re-adding would push
 * the op to the back of the queue, where it could end up sent after a comment
 * that depends on the expense it creates.
 */
export type OutboxDecision =
  | { action: "insert"; entry: Omit<OutboxOp, "seq"> }
  | { action: "replace"; entry: Omit<OutboxOp, "seq"> }
  | { action: "drop" }
  | { action: "ignore"; reason: string };

const CREATE_KINDS: OutboxKind[] = ["expense.create", "payment.create", "comment.create"];

function isCreate(kind: OutboxKind): boolean {
  return CREATE_KINDS.includes(kind);
}

/**
 * Folds a local write into whatever is already queued for that entity.
 *
 * `queuedAt` is passed in rather than read from a clock so this stays pure. It is
 * advisory metadata only - the server stamps what it accepts, and a client
 * timestamp is never used to decide a winner.
 */
export function reduceOutbox(
  pending: OutboxOp | undefined,
  write: LocalWrite,
  queuedAt: string,
): OutboxDecision {
  const entry = (
    kind: OutboxKind,
    payload: unknown,
    baseVersion: number | null,
  ): Omit<OutboxOp, "seq"> => ({
    id: write.id,
    kind,
    baseVersion,
    payload,
    status: "pending",
    reason: null,
    queuedAt,
  });

  // Nothing queued: the write becomes the queue entry, and a version-bearing one
  // freezes the base it was made against.
  if (!pending) {
    switch (write.kind) {
      case "expense.create":
      case "payment.create":
        return { action: "insert", entry: entry(write.kind, write.payload, null) };
      case "comment.create":
        return { action: "insert", entry: entry("comment.create", write.payload, null) };
      case "comment.delete":
        return { action: "insert", entry: entry("comment.delete", null, null) };
      case "expense.update":
        return {
          action: "insert",
          entry: entry("expense.update", write.payload, write.baseVersion),
        };
      case "expense.delete":
        return { action: "insert", entry: entry("expense.delete", null, write.baseVersion) };
      case "expense.restore":
        return { action: "insert", entry: entry("expense.restore", null, write.baseVersion) };
    }
  }

  switch (write.kind) {
    // --- creates ----------------------------------------------------------
    // A repeated create of the same id is a retry, not a second bill. Replace the
    // payload so the newest wording wins and leave the entry where it is.
    case "expense.create":
    case "payment.create":
    case "comment.create":
      return { action: "replace", entry: entry(pending.kind, write.payload, pending.baseVersion ?? null) };

    // --- editing ----------------------------------------------------------
    case "expense.update": {
      // Still a create as far as the server is concerned: it has never seen this
      // row, so there is nothing to update and nothing that could conflict.
      if (isCreate(pending.kind)) {
        return { action: "replace", entry: entry(pending.kind, write.payload, null) };
      }
      // Restore-and-replace: one round trip that brings the row back and then
      // applies the new contents. The client cannot know the post-restore version
      // in between, which is exactly why this is one op rather than two.
      if (pending.kind === "expense.restore") {
        return {
          action: "replace",
          entry: entry("expense.restore", write.payload, pending.baseVersion ?? null),
        };
      }
      if (pending.kind === "expense.delete") {
        // Unreachable from the UI: a locally-deleted bill shows as a tombstone
        // with an undo, not an editable form. Ignored rather than guessed at,
        // because both readings (resurrect it, or discard the edit) would be a
        // decision this function has no business making.
        return { action: "ignore", reason: "That expense is deleted. Undo the delete first." };
      }
      // Ten edits keep the FIRST baseVersion. See the module header.
      return {
        action: "replace",
        entry: entry("expense.update", write.payload, pending.baseVersion ?? null),
      };
    }

    // --- deleting ---------------------------------------------------------
    case "expense.delete": {
      // It never left this device, so nothing has to be told it is gone.
      if (isCreate(pending.kind)) return { action: "drop" };
      // Undo of a queued restore: the row goes back to being the tombstone the
      // server already has, and neither op needs to travel.
      if (pending.kind === "expense.restore") return { action: "drop" };
      if (pending.kind === "expense.delete") {
        return { action: "ignore", reason: "Already queued for deletion." };
      }
      // A queued edit becomes a delete at the same base. Sending both would ask
      // the server to apply an edit and then throw it away.
      return { action: "replace", entry: entry("expense.delete", null, pending.baseVersion ?? null) };
    }

    case "expense.restore": {
      // Delete-then-undo never reaches the server at all.
      if (pending.kind === "expense.delete") return { action: "drop" };
      if (pending.kind === "expense.restore") {
        return { action: "ignore", reason: "Already queued for restore." };
      }
      return { action: "ignore", reason: "That expense is not deleted." };
    }

    // --- comments ---------------------------------------------------------
    case "comment.delete": {
      // Written and removed before either left the device.
      if (pending.kind === "comment.create") return { action: "drop" };
      return { action: "replace", entry: entry("comment.delete", null, null) };
    }
  }
}

// ---------------------------------------------------------------------------
// Pull versus a pending op
// ---------------------------------------------------------------------------

/** What arrived for an entity the client may have queued a write for. */
export type RemoteEvent =
  /** The row is live, with these contents. A restore looks like this too. */
  | { type: "upsert" }
  /** A ledger tombstone. Every device keeps the row and stops counting it. */
  | { type: "delete" }
  /** Drop your replica: you may not see this at all any more. */
  | { type: "forget" };

export interface Reconciliation {
  /** Write the server's row into the mirror. */
  applyRemote: boolean;
  /** Leave the queued op alone, to be pushed. */
  keepPending: boolean;
  /**
   * Mark the local row as a conflict and stash the server's copy next to it, for
   * a person to resolve. Never resolved by guessing: applying both versions of an
   * edit would double the money, so "keep both" is a UI affordance and never a
   * merge.
   */
  conflict: boolean;
}

/**
 * Whether a pulled change may overwrite what is queued locally.
 *
 * The asymmetry here is the whole policy, and each line of it is a decision:
 *
 *   - **Delete and forget always win.** Whatever is queued is dropped and the
 *     remote is applied. Pushing an edit on top of somebody else's deletion would
 *     resurrect a bill they meant to remove, and a `forget` means the caller has
 *     no business holding the row at all.
 *   - **A pending write is never overwritten by an ordinary upsert.** Push it and
 *     let the server's `baseVersion` check decide: that is where `applied` and
 *     `conflict` are distinguished, and doing it here would mean re-implementing
 *     the check against a version the client cannot be sure of.
 *   - **A pending DELETE against a live remote row is a conflict**, not a silent
 *     re-delete. Somebody else has just restored this, deliberately; pushing the
 *     delete on top of their undo is exactly the surprise this table exists to
 *     prevent.
 *   - **A pending create ignores echoes.** The server has not confirmed the id
 *     yet, so an upsert arriving now is either somebody else's row with the same
 *     id (impossible) or this device's own write coming back; either way the push
 *     result is what settles it.
 */
export function reconcileRemote(
  pending: OutboxOp | undefined,
  remote: RemoteEvent,
): Reconciliation {
  if (remote.type === "delete" || remote.type === "forget") {
    return { applyRemote: true, keepPending: false, conflict: false };
  }

  if (!pending) return { applyRemote: true, keepPending: false, conflict: false };

  if (pending.kind === "expense.delete") {
    return { applyRemote: false, keepPending: true, conflict: true };
  }

  return { applyRemote: false, keepPending: true, conflict: false };
}

// ---------------------------------------------------------------------------
// Push order
// ---------------------------------------------------------------------------

/**
 * Sorts a batch so a parent always exists before its child.
 *
 * `expense.create` and `payment.create` first, then the ops that change an
 * existing expense, then comments. A `comment.create` whose expense is still
 * sitting later in the same `ops` array is `rejected` by the server - correctly,
 * since the bill genuinely does not exist yet - so getting this wrong turns a
 * perfectly good offline dinner and its note into a quarantine entry.
 *
 * Within a tier, insertion order (`seq`) is preserved, so two edits the user made
 * in a particular order arrive in that order.
 */
const PUSH_TIER: Record<OutboxKind, number> = {
  "expense.create": 0,
  "payment.create": 0,
  "expense.update": 1,
  "expense.restore": 1,
  "expense.delete": 1,
  "comment.create": 2,
  "comment.delete": 2,
};

export function sortForPush<T extends { kind: OutboxKind; seq?: number }>(ops: T[]): T[] {
  return ops
    .slice()
    .sort((a, b) => PUSH_TIER[a.kind] - PUSH_TIER[b.kind] || (a.seq ?? 0) - (b.seq ?? 0));
}
