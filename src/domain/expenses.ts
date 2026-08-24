/**
 * Expense writes.
 *
 * THIS IS THE ONLY MODULE ALLOWED TO WRITE `expenses`, `expense_users`, OR
 * `expense_repayments`. Everything else goes through these functions.
 *
 * The reason is the expense invariant from migrations/001: paid shares and owed
 * shares must each sum to the expense total, and expense_repayments must be a
 * faithful derivation of expense_users. SQLite cannot enforce either across
 * rows, so correctness depends on every write taking this path, inside one
 * transaction, with the split engine deciding the numbers.
 */
import { sql } from "kysely";
import type { DB } from "../db/index.ts";
import { db, transaction } from "../db/index.ts";
import {
  computeSplit,
  deriveRepayments,
  type Repayment,
  type SplitItem,
  type SplitParticipant,
  type SplitType,
} from "./split.ts";
import { isUlid, ulid } from "./ulid.ts";
import { parseMetadata, serializeMetadata, type EntityMetadata } from "./metadata.ts";
import { recordExpenseEvent, snapshotExpense } from "./comments.ts";
import { isRepeatInterval, nextOccurrence, nextOccurrenceOnOrAfter, type RepeatInterval } from "./recurring.ts";
import { logChange, logExpenseAudience, participantIds } from "./sync-log.ts";

export interface CreateExpenseInput {
  /**
   * Client-minted primary key. Must be a valid ULID. A retry with the same id
   * is a no-op that returns the existing row - that is the offline-first
   * idempotency story. Absent: the server mints one.
   */
  id?: string;
  groupId?: string | null;
  description: string;
  details?: string | null;
  costMinor: number;
  currencyCode: string;
  /** ISO-8601. Date-only input is normalised to midnight UTC. */
  date: string;
  categoryId?: number | null;
  splitType: SplitType;
  participants: SplitParticipant[];
  /**
   * Line items, for `splitType: "itemized"` only. They decide the owed shares
   * and are also persisted verbatim to `expenses.split_meta` so the editor can
   * reopen the bill, but the shares in expense_users stay authoritative.
   */
  items?: SplitItem[];
  /**
   * The named part of the gap between the line items and the total, for
   * `itemized` only. Presentation detail: the engine already spreads whatever
   * the lines do not cover in proportion to what each person ordered, so these
   * change no share. They are stored so the editor reopens the bill with the
   * same two boxes, and are rejected unless they agree with that gap; a stored
   * tip that does not match the money is worse than no tip at all.
   */
  taxMinor?: number | null;
  tipMinor?: number | null;
  isPayment?: boolean;
  paymentMethod?: string | null;
  /**
   * Makes this expense a recurring TEMPLATE. `next_repeat` is derived from the
   * expense's own date (one interval later) rather than being accepted from the
   * client: the schedule belongs to the server clock, and a client that could
   * name the fire time could ask for one in 1970.
   */
  repeatInterval?: RepeatInterval | null;
  /**
   * The template this row was generated from. Set ONLY by
   * src/domain/scheduler.ts; an occurrence is an ordinary expense in every other
   * respect and never repeats itself (schema CHECK).
   */
  repeatOf?: string | null;
  createdBy: string;
  /**
   * JSON bag written as `expenses.metadata`. The importer stamps
   * `{ splitwise_id }` so a second run can match, and `repeat_paused` when a
   * Splitwise repeating bill lands as a stopped series. Native creates omit it.
   */
  metadata?: EntityMetadata;
  /**
   * Defaults to true. The Splitwise importer sets it false and writes one
   * summary entry per run instead (a thousand imported expenses would
   * otherwise bury every real event in the feed under a wall of history.
   */
  recordActivity?: boolean;
  /**
   * When the row originally came into existence. Import passes Splitwise
   * `created_at` (or the expense `date`) so the column matches the ULID time.
   * Absent: SQLite's `datetime('now')`.
   */
  createdAt?: string;
  /**
   * A preferred who-pays-whom pairing, as a HINT to `deriveRepayments`.
   *
   * Net positions do not pin down the pairing (see the long comment on
   * `deriveRepayments`), and greedy matching picks a valid but arbitrary one.
   * That is fine for an expense this app authored, and wrong for one imported
   * from a system that already published its own answer: on a non-group bill
   * the arbitrary pairing surfaces as a one-on-one debt the other side has no
   * record of.
   *
   * The Splitwise importer passes `repayments` straight from the API. It stays
   * a hint - each entry is clamped to what the shares support and greedy fills
   * the rest - so this cannot make `expense_repayments` disagree with
   * `expense_users`, and rule 4 still holds.
   */
  repayments?: readonly Repayment[];
}

export class ExpenseError extends Error {}

/**
 * A write whose `expectedVersion` no longer matches the stored row.
 *
 * Somebody else has edited, deleted or restored this expense since the version
 * the caller was working from. That is a CONFLICT, not something to resolve by
 * guessing: `/api/v1/sync/push` hands the caller the server's row and its own
 * queued op back, and a person decides. See docs/OFFLINE.md, "Conflicts are
 * surfaced, not silently resolved".
 *
 * Assigned in the constructor body rather than as parameter properties;
 * `--experimental-strip-types` rejects those.
 */
export class ExpenseConflictError extends ExpenseError {
  readonly expenseId: string;
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(expenseId: string, expectedVersion: number, currentVersion: number) {
    super(
      `Expense ${expenseId} has changed since you last saw it (you had version ${expectedVersion}, it is now ${currentVersion})`,
    );
    this.expenseId = expenseId;
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

/** What `deleteExpense` / `restoreExpense` report back. */
export interface ExpenseStateResult {
  /** The row's `version` after the write. */
  version: number;
  /**
   * The row was already in the state the caller asked for, so nothing was
   * written and no version was consumed. Push maps this to `duplicate`, which is
   * why deleting or restoring twice is not an error.
   */
  noop: boolean;
}

/**
 * Checks `expectedVersion` against the stored row, inside the caller's
 * transaction.
 *
 * Absent means "I am not doing optimistic concurrency" - the ordinary
 * online path, where the client read the row a moment ago and the last write
 * wins as it always has. Only the sync layer sends one.
 */
function assertVersion(
  expenseId: string,
  expected: number | undefined,
  current: number,
): void {
  if (expected !== undefined && expected !== current) {
    throw new ExpenseConflictError(expenseId, expected, current);
  }
}

/**
 * Creates an expense with its shares and derived repayments, atomically.
 */
export async function createExpense(input: CreateExpenseInput): Promise<string> {
  if (input.id !== undefined && !isUlid(input.id)) {
    throw new ExpenseError("Invalid expense id");
  }

  return transaction(async (trx) => {
    // First writer wins: a retry of a client-minted id must not re-validate or
    // rewrite the existing row. Check before computeSplit so a replayed body
    // that would no longer parse still returns the original expense.
    if (input.id) {
      const existing = await trx
        .selectFrom("expenses")
        .select("id")
        .where("id", "=", input.id)
        .executeTakeFirst();
      if (existing) return existing.id;
    }

    const shares = computeSplit(input.costMinor, input.splitType, input.participants, {
      items: input.items,
    });
    const repayments = deriveRepayments(shares, input.repayments);
    const date = normaliseDate(input.date);
    const splitMeta = serialiseSplitMeta(input);
    const repeatInterval = input.repeatInterval ?? null;

    await assertParticipantsAreMembers(trx, input.groupId ?? null, shares.map((s) => s.userId));

    const id = input.id ?? ulid();

    try {
      await trx
        .insertInto("expenses")
        .values({
          id,
          metadata: serializeMetadata(input.metadata ?? {}),
          group_id: input.groupId ?? null,
          description: input.description,
          details: input.details ?? null,
          cost_minor: input.costMinor,
          currency_code: input.currencyCode.toUpperCase(),
          date,
          category_id: input.categoryId ?? null,
          split_type: input.splitType,
          split_meta: splitMeta,
          is_payment: input.isPayment ? 1 : 0,
          payment_method: input.paymentMethod ?? null,
          repeat_interval: repeatInterval,
          next_repeat: repeatInterval ? nextOccurrence(date, repeatInterval) : null,
          repeat_of: input.repeatOf ?? null,
          created_by: input.createdBy,
          updated_by: input.createdBy,
          // `updated_at` is pinned to `created_at`, not left to default to now.
          // A row that has never been edited should say so, and the Splitwise
          // importer relies on exactly that to tell "nobody has touched this
          // since it came across" from "somebody edited it here" when deciding
          // whether a re-import may overwrite it (docs/PARITY.md slice 5).
          ...(input.createdAt ? { created_at: input.createdAt, updated_at: input.createdAt } : {}),
        })
        .execute();
    } catch (err) {
      // Concurrent retry of the same client-minted id: the first writer won.
      const raced = await trx
        .selectFrom("expenses")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst();
      if (raced) return raced.id;
      throw err;
    }

    await writeSharesAndRepayments(trx, id, shares, repayments);

    if (input.recordActivity !== false) {
      await trx
        .insertInto("activity")
        .values({
          id: ulid(),
          user_id: input.createdBy,
          group_id: input.groupId ?? null,
          expense_id: id,
          action: input.isPayment ? "payment.created" : "expense.created",
          payload: JSON.stringify({ description: input.description }),
        })
        .execute();
    }

    // Unconditional, unlike the feed entry above: `recordActivity: false` means
    // "do not narrate this to a person", and the importer sets it for a thousand
    // rows at a time. Other devices still have to receive all thousand.
    await logChange(trx, {
      entity: "expense",
      entityId: id,
      op: "upsert",
      groupId: input.groupId ?? null,
      actorUserId: input.createdBy,
    });

    return id;
  });
}

export interface UpdateExpenseInput
  extends Omit<CreateExpenseInput, "createdBy" | "id" | "repeatOf" | "createdAt"> {
  updatedBy: string;
  /**
   * The `version` the caller believes it is editing. Absent skips the check,
   * which is the ordinary online path; `/api/v1/sync/push` always sends one, and
   * a mismatch throws `ExpenseConflictError` rather than overwriting somebody
   * else's edit. See docs/OFFLINE.md.
   */
  expectedVersion?: number;
  /**
   * Overrides the `updated_at` stamp. The Splitwise importer passes one and
   * records it in `metadata.splitwise_synced_at`, which is how a later run tells
   * "refreshed from Splitwise" apart from "edited here". Nothing else should set
   * it: an update that claims not to have happened is a lie to every other
   * device.
   */
  updatedAt?: string;
  /**
   * Written only when present, so a native edit never has to know what the
   * importer stamped. Rule 3 means this is the only path that may write the
   * column at all.
   */
  metadata?: EntityMetadata;
  /**
   * Defaults to true. False suppresses BOTH the feed entry and the system
   * comment; the Splitwise importer uses it, because refreshing an imported row
   * is not a person editing a bill and should not read like one.
   */
  recordActivity?: boolean;
}

/**
 * Replaces an expense's contents.
 *
 * Shares and repayments are deleted and rewritten rather than diffed; an
 * expense has a handful of rows, and a full rewrite cannot leave a stale
 * participant behind the way a partial update can.
 *
 * Returns the `updated_at` it wrote, so a caller that has to remember when it
 * last touched a row does not have to read it back and guess, and the new
 * `version`, so `/api/v1/sync/push` can tell the client what to base its next
 * edit on without a second read that a concurrent write could poison.
 */
export async function updateExpense(
  expenseId: string,
  input: UpdateExpenseInput,
  now: Date = new Date(),
): Promise<{ updatedAt: string; version: number }> {
  const shares = computeSplit(input.costMinor, input.splitType, input.participants, {
    items: input.items,
  });
  const repayments = deriveRepayments(shares, input.repayments);
  const date = normaliseDate(input.date);
  // Always written, never left alone: editing an itemized expense into a
  // percent one has to clear the old line items, or the editor would reopen a
  // bill that no longer describes the split.
  const splitMeta = serialiseSplitMeta(input);
  const updatedAt = input.updatedAt ?? new Date().toISOString().replace("T", " ").slice(0, 19);

  const version = await transaction(async (trx) => {
    const existing = await trx
      .selectFrom("expenses")
      .select([
        "id", "deleted_at", "repeat_interval", "next_repeat", "repeat_of", "date",
        "group_id", "version", "metadata",
      ])
      .where("id", "=", expenseId)
      .executeTakeFirst();

    if (!existing) throw new ExpenseError(`Expense ${expenseId} not found`);
    if (existing.deleted_at) throw new ExpenseError(`Expense ${expenseId} is deleted`);
    assertVersion(expenseId, input.expectedVersion, existing.version);

    await assertParticipantsAreMembers(trx, input.groupId ?? null, shares.map((s) => s.userId));

    // Read before the rewrite below throws them away, so the audience diff can
    // tell "removed from the bill" from "was never on it".
    const participantsBefore = await participantIds(trx, expenseId);

    // Snapshotted before the write so the system comment can describe what
    // actually changed rather than what the request asked for.
    const before = input.recordActivity === false ? null : await snapshotExpense(trx, expenseId);

    // ABSENT MEANS "LEAVE THE SCHEDULE ALONE"; explicit null means "stop
    // repeating". The distinction is load-bearing: the guest edit dialog has no
    // repeat control and sends nothing, and silently ending someone's rent
    // series because a guest fixed a typo would be a bad surprise.
    //
    // An occurrence can never become a template (schema CHECK), and editing a
    // template must not move bills that already happened: only `next_repeat`
    // moves, and only forward from the new date.
    //
    // Resume is different from first turning repeating on. Walking from the
    // original bill date would put `next_repeat` months ago and the scheduler
    // would backfill every skipped month. Resume starts from `now`.
    const existingMeta = parseMetadata(existing.metadata);
    const existingInterval = isRepeatInterval(existing.repeat_interval)
      ? existing.repeat_interval
      : null;
    const requested =
      input.repeatInterval === undefined
        ? existingInterval
        : input.repeatInterval;
    const repeatInterval = existing.repeat_of !== null ? null : requested;
    const nextRepeat =
      repeatInterval === null
        ? null
        : repeatInterval === existingInterval && existing.next_repeat !== null && date === existing.date
          ? existing.next_repeat
          : existingInterval === null && isRepeatInterval(existingMeta.repeat_paused)
            ? nextOccurrenceOnOrAfter(date, repeatInterval, now)
            : nextOccurrence(date, repeatInterval);

    const nextMeta: EntityMetadata = { ...(input.metadata ?? existingMeta) };
    if (repeatInterval === null && existingInterval !== null) {
      nextMeta.repeat_paused = existingInterval;
    } else if (repeatInterval !== null) {
      delete nextMeta.repeat_paused;
    }
    const writeMetadata =
      input.metadata !== undefined ||
      nextMeta.repeat_paused !== existingMeta.repeat_paused;

    // `version = version + 1` in the statement, and `version = :expected` in the
    // WHERE, rather than a read-then-write of a number we already have. The
    // check above would be enough on its own under SQLite's write locking, but
    // making the guard part of the UPDATE means the row cannot be edited between
    // the two even if this ever runs somewhere with looser isolation.
    const written = await trx
      .updateTable("expenses")
      .set({
        group_id: input.groupId ?? null,
        description: input.description,
        details: input.details ?? null,
        cost_minor: input.costMinor,
        currency_code: input.currencyCode.toUpperCase(),
        date,
        category_id: input.categoryId ?? null,
        split_type: input.splitType,
        split_meta: splitMeta,
        is_payment: input.isPayment ? 1 : 0,
        payment_method: input.paymentMethod ?? null,
        repeat_interval: repeatInterval,
        next_repeat: nextRepeat,
        version: sql<number>`version + 1`,
        updated_by: input.updatedBy,
        updated_at: updatedAt,
        ...(writeMetadata ? { metadata: serializeMetadata(nextMeta) } : {}),
      })
      .where("id", "=", expenseId)
      .$if(input.expectedVersion !== undefined, (qb) =>
        qb.where("version", "=", input.expectedVersion!),
      )
      .executeTakeFirst();

    if (Number(written?.numUpdatedRows ?? 0) === 0) {
      throw new ExpenseConflictError(expenseId, input.expectedVersion ?? 0, existing.version);
    }

    await trx.deleteFrom("expense_users").where("expense_id", "=", expenseId).execute();
    await trx.deleteFrom("expense_repayments").where("expense_id", "=", expenseId).execute();

    await writeSharesAndRepayments(trx, expenseId, shares, repayments);

    await logChange(trx, {
      entity: "expense",
      entityId: expenseId,
      op: "upsert",
      groupId: input.groupId ?? null,
      actorUserId: input.updatedBy,
    });

    // Who can no longer see this bill, and who has just been handed one whose
    // conversation they have never pulled. See logExpenseAudience.
    await logExpenseAudience(trx, {
      expenseId,
      actorId: input.updatedBy,
      groupId: input.groupId ?? null,
      previousGroupId: existing.group_id,
      before: participantsBefore,
      after: shares.map((s) => s.userId),
    });

    if (input.recordActivity === false) return existing.version + 1;

    await trx
      .insertInto("activity")
      .values({
        id: ulid(),
        user_id: input.updatedBy,
        group_id: input.groupId ?? null,
        expense_id: expenseId,
        action: "expense.updated",
        payload: JSON.stringify({ description: input.description }),
      })
      .execute();

    // The bill's own history, next to the global feed entry above. Best-effort
    // by contract: see recordExpenseEvent.
    const after = await snapshotExpense(trx, expenseId);
    if (before && after) {
      await recordExpenseEvent(trx, {
        expenseId,
        actorId: input.updatedBy,
        event: { kind: "updated", before, after },
      });
    }

    return existing.version + 1;
  });

  return { updatedAt, version };
}

/**
 * Turns a stopped series back on, from today, without backfilling.
 *
 * Rebuilds the update from the stored row so callers (the import wizard) do
 * not have to re-send the split. Same resume rule as an ordinary PATCH:
 * `next_repeat` walks forward from the bill date until it is on or after
 * `now`. Already-live templates are a no-op.
 */
export async function resumeRepeat(
  expenseId: string,
  updatedBy: string,
  now: Date = new Date(),
): Promise<"resumed" | "already_live"> {
  const existing = await db
    .selectFrom("expenses")
    .select([
      "id",
      "deleted_at",
      "repeat_interval",
      "repeat_of",
      "group_id",
      "description",
      "details",
      "cost_minor",
      "currency_code",
      "date",
      "category_id",
      "split_type",
      "split_meta",
      "is_payment",
      "payment_method",
      "metadata",
    ])
    .where("id", "=", expenseId)
    .executeTakeFirst();

  if (!existing) throw new ExpenseError(`Expense ${expenseId} not found`);
  if (existing.deleted_at) throw new ExpenseError(`Expense ${expenseId} is deleted`);
  if (existing.repeat_of !== null) {
    throw new ExpenseError("An occurrence cannot become a template");
  }
  if (isRepeatInterval(existing.repeat_interval)) return "already_live";

  const paused = parseMetadata(existing.metadata).repeat_paused;
  if (!isRepeatInterval(paused)) {
    throw new ExpenseError("Expense is not a stopped series");
  }

  const shares = await db
    .selectFrom("expense_users")
    .select(["user_id", "paid_share_minor", "split_input"])
    .where("expense_id", "=", expenseId)
    .execute();

  await updateExpense(
    expenseId,
    {
      groupId: existing.group_id,
      description: existing.description,
      details: existing.details,
      costMinor: existing.cost_minor,
      currencyCode: existing.currency_code,
      date: existing.date,
      categoryId: existing.category_id,
      splitType: asSplitType(existing.split_type),
      participants: shares.map((s) => ({
        userId: s.user_id,
        paidMinor: s.paid_share_minor,
        ...(s.split_input != null ? { input: s.split_input } : {}),
      })),
      ...splitMetaFields(existing.split_type, existing.split_meta),
      isPayment: existing.is_payment === 1,
      paymentMethod: existing.payment_method,
      repeatInterval: paused,
      updatedBy,
    },
    now,
  );

  return "resumed";
}

function asSplitType(value: string): SplitType {
  switch (value) {
    case "equal":
    case "exact":
    case "percent":
    case "shares":
    case "adjustment":
    case "itemized":
      return value;
    default:
      throw new ExpenseError(`Unknown split type ${value}`);
  }
}

function splitMetaFields(
  splitType: string,
  raw: string | null,
): { items?: SplitItem[]; taxMinor?: number; tipMinor?: number } {
  if (splitType !== "itemized" || !raw) return {};
  try {
    const parsed = JSON.parse(raw) as {
      items?: SplitItem[];
      taxMinor?: number;
      tipMinor?: number;
    };
    return {
      ...(Array.isArray(parsed.items) ? { items: parsed.items } : {}),
      ...(typeof parsed.taxMinor === "number" ? { taxMinor: parsed.taxMinor } : {}),
      ...(typeof parsed.tipMinor === "number" ? { tipMinor: parsed.tipMinor } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Soft-deletes an expense.
 *
 * Repayment rows are left in place; every balance query filters on
 * `expenses.deleted_at IS NULL`, so a deleted expense stops affecting balances
 * without losing the history. Undo (`restoreExpense`) needs the tombstone,
 * which is the other reason not to hard-delete.
 *
 * Deleting a TEMPLATE stops the series and nothing else: the scheduler only
 * looks at live rows, and the bills it already generated are real money that
 * somebody still owes.
 *
 * The version bump is what makes delete-wins work rather than being a silent
 * rejection: a device holding a queued edit at the old version pushes it, gets a
 * conflict, and is told the row is a tombstone now - instead of quietly
 * resurrecting somebody else's deletion.
 */
export async function deleteExpense(
  expenseId: string,
  deletedBy: string,
  options: { expectedVersion?: number } = {},
): Promise<ExpenseStateResult> {
  return transaction(async (trx) => {
    const expense = await trx
      .selectFrom("expenses")
      .select(["id", "group_id", "deleted_at", "version"])
      .where("id", "=", expenseId)
      .executeTakeFirst();

    if (!expense) throw new ExpenseError(`Expense ${expenseId} not found`);
    assertVersion(expenseId, options.expectedVersion, expense.version);
    // Already gone. Deleting twice is not an error, and it consumes no version:
    // push reports it as `duplicate` and the client drops its queued op.
    if (expense.deleted_at) return { version: expense.version, noop: true };

    await trx
      .updateTable("expenses")
      .set({
        deleted_at: sql`datetime('now')`,
        version: sql<number>`version + 1`,
        updated_by: deletedBy,
      })
      .where("id", "=", expenseId)
      .execute();

    await trx
      .insertInto("activity")
      .values({
        id: ulid(),
        user_id: deletedBy,
        group_id: expense.group_id,
        expense_id: expenseId,
        action: "expense.deleted",
      })
      .execute();

    await recordExpenseEvent(trx, { expenseId, actorId: deletedBy, event: { kind: "deleted" } });

    // `delete`, not `forget`: this is a ledger tombstone. Every device keeps the
    // row and stops counting it, which is what makes the undo below possible
    // from any of them.
    await logChange(trx, {
      entity: "expense",
      entityId: expenseId,
      op: "delete",
      groupId: expense.group_id,
      actorUserId: deletedBy,
    });

    return { version: expense.version + 1, noop: false };
  });
}

/**
 * Undoes a soft delete.
 *
 * The tombstone was always recoverable in principle; this is the path that makes
 * it recoverable in practice. Repayments are rebuilt from `expense_users` rather
 * than trusted, because they are a cache (rule 4) and the row has been sitting
 * outside every balance query since the delete - rebuilding is cheap and means a
 * restored expense cannot come back with a stale derivation attached.
 *
 * Restoring twice is a no-op, so a double-tapped undo is not an error.
 *
 * A FIRST-CLASS WRITE, not an update that happens to clear `deleted_at`:
 * `updateExpense` refuses deleted rows and that stays. It bumps `version` for
 * the same reason delete does - otherwise the restored row still looks like the
 * tombstone it replaced, and a stale edit at the old version would overwrite
 * somebody else's undo.
 */
export async function restoreExpense(
  expenseId: string,
  restoredBy: string,
  options: { expectedVersion?: number } = {},
): Promise<ExpenseStateResult> {
  return transaction(async (trx) => {
    const expense = await trx
      .selectFrom("expenses")
      .select(["id", "group_id", "deleted_at", "version"])
      .where("id", "=", expenseId)
      .executeTakeFirst();

    if (!expense) throw new ExpenseError(`Expense ${expenseId} not found`);
    assertVersion(expenseId, options.expectedVersion, expense.version);
    if (!expense.deleted_at) return { version: expense.version, noop: true }; // already live

    const shares = await trx
      .selectFrom("expense_users")
      .select(["user_id", "paid_share_minor", "owed_share_minor", "split_input"])
      .where("expense_id", "=", expenseId)
      .execute();

    // An expense with no participants would come back invisible to everyone and
    // would fail `yarn db:check`'s expenses_have_participants. Refuse instead.
    if (shares.length === 0) {
      throw new ExpenseError(`Expense ${expenseId} has no participants to restore`);
    }

    await trx
      .updateTable("expenses")
      .set({
        deleted_at: null,
        version: sql<number>`version + 1`,
        updated_by: restoredBy,
        updated_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      })
      .where("id", "=", expenseId)
      .execute();

    await trx.deleteFrom("expense_repayments").where("expense_id", "=", expenseId).execute();

    const repayments = deriveRepayments(
      shares.map((s) => ({
        userId: s.user_id,
        paidMinor: s.paid_share_minor,
        owedMinor: s.owed_share_minor,
        input: s.split_input,
      })),
    );

    if (repayments.length > 0) {
      await trx
        .insertInto("expense_repayments")
        .values(
          repayments.map((r, seq) => ({
            expense_id: expenseId,
            seq,
            from_user_id: r.fromUserId,
            to_user_id: r.toUserId,
            amount_minor: r.amountMinor,
          })),
        )
        .execute();
    }

    await trx
      .insertInto("activity")
      .values({
        id: ulid(),
        user_id: restoredBy,
        group_id: expense.group_id,
        expense_id: expenseId,
        action: "expense.restored",
      })
      .execute();

    await recordExpenseEvent(trx, { expenseId, actorId: restoredBy, event: { kind: "restored" } });

    // `upsert`: the row is live again. A tombstone is not a second identity, so
    // there is nothing here for a client to un-delete separately - it replaces
    // its local copy with this one and starts counting it again.
    await logChange(trx, {
      entity: "expense",
      entityId: expenseId,
      op: "upsert",
      groupId: expense.group_id,
      actorUserId: restoredBy,
    });

    return { version: expense.version + 1, noop: false };
  });
}

/**
 * Records that the importer has just synced this row, without pretending a person
 * edited it.
 *
 * Lives here because rule 3 has no exceptions: `expenses` has exactly one writer,
 * including for a column the ledger does not read. It writes `metadata` and
 * `updated_at` and nothing else - no shares, no repayments, no activity.
 *
 * `updated_at` is set explicitly rather than left alone, because the
 * `trg_expenses_updated_at` trigger stamps `datetime('now')` on any UPDATE that
 * does not change it, and an unexplained bump is exactly what would make the next
 * re-import think somebody had edited the row by hand. Stamping
 * `splitwise_synced_at` with the same value is what keeps the two in step.
 *
 * THE FORMAT IS FULL ISO WITH MILLISECONDS, deliberately unlike the
 * `YYYY-MM-DD HH:MM:SS` a native edit writes. Import stamps and human edits are
 * then distinguishable by construction rather than by luck: with second
 * resolution, somebody editing a bill in the same second as a refresh would look
 * to the next run like the refresh itself, and their edit would be overwritten.
 *
 * Returns the timestamp written.
 */
export function importStamp(): string {
  return new Date().toISOString();
}

export async function markImportSynced(
  expenseId: string,
  patch: EntityMetadata = {},
  unset: readonly string[] = [],
): Promise<string> {
  const stamp = importStamp();

  await transaction(async (trx) => {
    const row = await trx
      .selectFrom("expenses")
      .select("metadata")
      .where("id", "=", expenseId)
      .executeTakeFirst();

    if (!row) throw new ExpenseError(`Expense ${expenseId} not found`);

    const meta: EntityMetadata = {
      ...parseMetadata(row.metadata),
      ...patch,
    };
    for (const key of unset) delete meta[key];

    await trx
      .updateTable("expenses")
      .set({
        metadata: serializeMetadata({
          ...meta,
          splitwise_synced_at: stamp,
        }),
        updated_at: stamp,
      })
      .where("id", "=", expenseId)
      .execute();
  });

  return stamp;
}

/**
 * Moves a template's `next_repeat` on by exactly one interval.
 *
 * Lives here rather than in the scheduler because rule 3 is "nothing else writes
 * `expenses`", and that includes a column the ledger does not depend on.
 *
 * `from` is the value the caller believes is current, and it is part of the WHERE
 * clause: two overlapping ticks then cannot advance the same series twice, and
 * the loser simply does nothing. Returns whether it moved.
 *
 * ONE interval, never "catch up to now". A series that fell behind during
 * downtime is meant to stay behind and be worked through one bill per tick, each
 * dated the day it was due; the alternative is three months of rent appearing at
 * once, all dated today.
 *
 * DOES NOT BUMP `version`. This is the server's clock moving, not a person
 * editing a bill: if a monthly tick bumped the version, everyone with a pending
 * offline typo fix on their rent template would get a conflict once a month, for
 * a change to a column they cannot even edit. It still writes a `sync_log` row,
 * because other devices do need the new `next_repeat` - it is what the UI reads
 * to say a series is behind. See docs/OFFLINE.md, "Scheduler".
 */
export async function advanceRepeatSchedule(
  templateId: string,
  from: string,
  interval: RepeatInterval,
): Promise<boolean> {
  return transaction(async (trx) => {
    const result = await trx
      .updateTable("expenses")
      .set({ next_repeat: nextOccurrence(from, interval) })
      .where("id", "=", templateId)
      .where("next_repeat", "=", from)
      .where("repeat_interval", "=", interval)
      .executeTakeFirst();

    if (Number(result?.numUpdatedRows ?? 0) === 0) return false;

    const template = await trx
      .selectFrom("expenses")
      .select("group_id")
      .where("id", "=", templateId)
      .executeTakeFirst();

    await logChange(trx, {
      entity: "expense",
      entityId: templateId,
      op: "upsert",
      groupId: template?.group_id ?? null,
      // Nobody did this. The scheduler is not a person, and an actor id here
      // would name whoever happened to create the series.
      actorUserId: null,
    });

    return true;
  });
}

/**
 * Moves an expense onto a different calendar date without bumping `version`.
 *
 * Import rounding uses this to sit leftover-cent settle-ups on the last real
 * bill's day so they do not look like new activity. Same versioning rule as
 * `advanceRepeatSchedule`: this is bookkeeping, not a person editing a bill.
 * Other devices still learn the new date via `sync_log`.
 */
export async function retargetExpenseDate(
  expenseId: string,
  date: string,
  actorUserId: string,
): Promise<boolean> {
  const normalised = normaliseDate(date);
  return transaction(async (trx) => {
    const existing = await trx
      .selectFrom("expenses")
      .select(["date", "group_id"])
      .where("id", "=", expenseId)
      .executeTakeFirst();
    if (!existing || existing.date === normalised) return false;

    await trx
      .updateTable("expenses")
      .set({ date: normalised })
      .where("id", "=", expenseId)
      .execute();

    await logChange(trx, {
      entity: "expense",
      entityId: expenseId,
      op: "upsert",
      groupId: existing.group_id,
      actorUserId,
    });

    return true;
  });
}

/**
 * Records a settle-up payment.
 *
 * Modelled as an ordinary expense with is_payment = 1, where the payer covers
 * the whole cost and the recipient owes all of it. That makes it fall out of
 * the same balance query as everything else instead of needing its own path.
 */
export async function createPayment(params: {
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
  currencyCode: string;
  groupId?: string | null;
  date?: string;
  description?: string;
  details?: string | null;
  paymentMethod?: string | null;
  createdBy: string;
}): Promise<string> {
  if (params.fromUserId === params.toUserId) {
    throw new ExpenseError("Cannot record a payment to yourself");
  }
  if (params.amountMinor <= 0) {
    throw new ExpenseError("Payment amount must be positive");
  }

  return createExpense({
    groupId: params.groupId ?? null,
    description: params.description ?? "Payment",
    details: params.details ?? null,
    costMinor: params.amountMinor,
    currencyCode: params.currencyCode,
    date: params.date ?? new Date().toISOString(),
    splitType: "exact",
    isPayment: true,
    paymentMethod: params.paymentMethod ?? null,
    createdBy: params.createdBy,
    participants: [
      // The payer hands over cash and owes nothing...
      { userId: params.fromUserId, paidMinor: params.amountMinor, input: 0 },
      // ...the recipient pays nothing and absorbs the full amount, which cancels
      // out an equivalent slice of what they were owed.
      { userId: params.toUserId, paidMinor: 0, input: params.amountMinor },
    ],
  });
}

// ---------------------------------------------------------------------------

/**
 * Renders the JSON blob for `expenses.split_meta`.
 *
 * Returns NULL for every split type that is fully described by expense_users -
 * which is all of them except itemized. The column has a CHECK enforcing that,
 * so this is the only shape the database will accept.
 *
 * Items are normalised on the way in (labels trimmed, empty ones dropped to
 * NULL, participant ids deduped and sorted) so the stored blob does not vary
 * with how the client happened to order its form state. computeSplit has
 * already validated them by the time this runs.
 *
 * Tax and tip are stored only when they account for the gap between the lines
 * and the total exactly. They are labels on money the engine has already
 * spread, so a pair that does not add up would be a caption contradicting the
 * ledger underneath it; rejected rather than rounded into agreement.
 */
function serialiseSplitMeta(input: {
  splitType: SplitType;
  costMinor: number;
  items?: SplitItem[];
  taxMinor?: number | null;
  tipMinor?: number | null;
}): string | null {
  const { splitType, items } = input;
  if (splitType !== "itemized") return null;
  if (!items || items.length === 0) return null;

  const tax = input.taxMinor ?? 0;
  const tip = input.tipMinor ?? 0;

  if (tax !== 0 || tip !== 0) {
    const itemTotal = items.reduce((sum, item) => sum + item.amountMinor, 0);
    const uncovered = input.costMinor - itemTotal;
    if (tax + tip !== uncovered) {
      throw new ExpenseError(
        `Tax (${tax}) and tip (${tip}) come to ${tax + tip}, but the line items leave ${uncovered} of the total unaccounted for`,
      );
    }
  }

  return JSON.stringify({
    items: items.map((item) => ({
      label: item.label?.trim() || null,
      amountMinor: item.amountMinor,
      participantIds: [...new Set(item.participantIds)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    })),
    ...(tax !== 0 ? { taxMinor: tax } : {}),
    ...(tip !== 0 ? { tipMinor: tip } : {}),
  });
}

async function writeSharesAndRepayments(
  trx: DB,
  expenseId: string,
  shares: ReturnType<typeof computeSplit>,
  repayments: ReturnType<typeof deriveRepayments>,
): Promise<void> {
  await trx
    .insertInto("expense_users")
    .values(
      shares.map((s) => ({
        expense_id: expenseId,
        user_id: s.userId,
        paid_share_minor: s.paidMinor,
        owed_share_minor: s.owedMinor,
        split_input: s.input,
      })),
    )
    .execute();

  if (repayments.length > 0) {
    await trx
      .insertInto("expense_repayments")
      .values(
        repayments.map((r, seq) => ({
          expense_id: expenseId,
          seq,
          from_user_id: r.fromUserId,
          to_user_id: r.toUserId,
          amount_minor: r.amountMinor,
        })),
      )
      .execute();
  }
}

/**
 * A group expense may only involve current group members. Without this check an
 * expense could quietly create a balance between two people who share no group,
 * which the UI has nowhere to display.
 */
async function assertParticipantsAreMembers(
  trx: DB,
  groupId: string | null,
  userIds: string[],
): Promise<void> {
  if (groupId === null) return;

  const members = await trx
    .selectFrom("group_members")
    .select("user_id")
    .where("group_id", "=", groupId)
    .where("left_at", "is", null)
    .execute();

  const memberIds = new Set(members.map((m) => m.user_id));
  const strangers = userIds.filter((id) => !memberIds.has(id));

  if (strangers.length > 0) {
    throw new ExpenseError(
      `User(s) ${strangers.join(", ")} are not members of group ${groupId}`,
    );
  }
}

/** Accepts "2026-08-17" or a full ISO timestamp; always stores a full one. */
function normaliseDate(date: string): string {
  const trimmed = date.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00Z`;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    throw new ExpenseError(`Invalid date: ${date}`);
  }
  return parsed.toISOString();
}
