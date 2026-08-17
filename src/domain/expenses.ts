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
  type SplitItem,
  type SplitParticipant,
  type SplitType,
} from "./split.ts";
import { isUlid, ulid } from "./ulid.ts";
import { parseMetadata, serializeMetadata, type EntityMetadata } from "./metadata.ts";
import { recordExpenseEvent, snapshotExpense } from "./comments.ts";
import { nextOccurrence, type RepeatInterval } from "./recurring.ts";

export interface CreateExpenseInput {
  /**
   * Client-minted primary key. Must be a valid ULID. A retry with the same id
   * is a no-op that returns the existing row — that is the offline-first
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
   * `{ splitwise_id }` so a second run can match; native creates omit it.
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
}

export class ExpenseError extends Error {}

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
    const repayments = deriveRepayments(shares);
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

    return id;
  });
}

export interface UpdateExpenseInput
  extends Omit<CreateExpenseInput, "createdBy" | "id" | "repeatOf" | "createdAt"> {
  updatedBy: string;
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
 * last touched a row does not have to read it back and guess.
 */
export async function updateExpense(
  expenseId: string,
  input: UpdateExpenseInput,
): Promise<string> {
  const shares = computeSplit(input.costMinor, input.splitType, input.participants, {
    items: input.items,
  });
  const repayments = deriveRepayments(shares);
  const date = normaliseDate(input.date);
  // Always written, never left alone: editing an itemized expense into a
  // percent one has to clear the old line items, or the editor would reopen a
  // bill that no longer describes the split.
  const splitMeta = serialiseSplitMeta(input);
  const updatedAt = input.updatedAt ?? new Date().toISOString().replace("T", " ").slice(0, 19);

  await transaction(async (trx) => {
    const existing = await trx
      .selectFrom("expenses")
      .select(["id", "deleted_at", "repeat_interval", "next_repeat", "repeat_of", "date"])
      .where("id", "=", expenseId)
      .executeTakeFirst();

    if (!existing) throw new ExpenseError(`Expense ${expenseId} not found`);
    if (existing.deleted_at) throw new ExpenseError(`Expense ${expenseId} is deleted`);

    await assertParticipantsAreMembers(trx, input.groupId ?? null, shares.map((s) => s.userId));

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
    const requested =
      input.repeatInterval === undefined
        ? (existing.repeat_interval as RepeatInterval | null)
        : input.repeatInterval;
    const repeatInterval = existing.repeat_of !== null ? null : requested;
    const nextRepeat =
      repeatInterval === null
        ? null
        : repeatInterval === existing.repeat_interval && existing.next_repeat !== null && date === existing.date
          ? // Same schedule, same date: leave the series where it is, so an
            // unrelated edit does not silently skip or duplicate a bill.
            existing.next_repeat
          : nextOccurrence(date, repeatInterval);

    await trx
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
        updated_by: input.updatedBy,
        updated_at: updatedAt,
        ...(input.metadata ? { metadata: serializeMetadata(input.metadata) } : {}),
      })
      .where("id", "=", expenseId)
      .execute();

    await trx.deleteFrom("expense_users").where("expense_id", "=", expenseId).execute();
    await trx.deleteFrom("expense_repayments").where("expense_id", "=", expenseId).execute();

    await writeSharesAndRepayments(trx, expenseId, shares, repayments);

    if (input.recordActivity === false) return;

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
  });

  return updatedAt;
}

/**
 * Soft-deletes an expense.
 *
 * Repayment rows are left in place; every balance query filters on
 * `expenses.deleted_at IS NULL`, so a deleted expense stops affecting balances
 * without losing the history. The compat API needs `deleted_at` on the way out,
 * which is the other reason not to hard-delete. It is also what makes
 * `restoreExpense` below possible at all.
 *
 * Deleting a TEMPLATE stops the series and nothing else: the scheduler only
 * looks at live rows, and the bills it already generated are real money that
 * somebody still owes.
 */
export async function deleteExpense(expenseId: string, deletedBy: string): Promise<void> {
  await transaction(async (trx) => {
    const expense = await trx
      .selectFrom("expenses")
      .select(["id", "group_id", "deleted_at"])
      .where("id", "=", expenseId)
      .executeTakeFirst();

    if (!expense) throw new ExpenseError(`Expense ${expenseId} not found`);
    if (expense.deleted_at) return; // already gone; deleting twice is not an error

    await trx
      .updateTable("expenses")
      .set({ deleted_at: sql`datetime('now')`, updated_by: deletedBy })
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
  });
}

/**
 * Undoes a soft delete.
 *
 * The tombstone was always recoverable in principle; this is the path that makes
 * it recoverable in practice. Repayments are rebuilt from `expense_users` rather
 * than trusted, because they are a cache (rule 4) and the row has been sitting
 * outside every balance query since the delete — rebuilding is cheap and means a
 * restored expense cannot come back with a stale derivation attached.
 *
 * Restoring twice is a no-op, so a double-tapped undo is not an error.
 */
export async function restoreExpense(expenseId: string, restoredBy: string): Promise<void> {
  await transaction(async (trx) => {
    const expense = await trx
      .selectFrom("expenses")
      .select(["id", "group_id", "deleted_at"])
      .where("id", "=", expenseId)
      .executeTakeFirst();

    if (!expense) throw new ExpenseError(`Expense ${expenseId} not found`);
    if (!expense.deleted_at) return; // already live

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
  });
}

/**
 * Records that the importer has just synced this row, without pretending a person
 * edited it.
 *
 * Lives here because rule 3 has no exceptions: `expenses` has exactly one writer,
 * including for a column the ledger does not read. It writes `metadata` and
 * `updated_at` and nothing else — no shares, no repayments, no activity.
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
): Promise<string> {
  const stamp = importStamp();

  await transaction(async (trx) => {
    const row = await trx
      .selectFrom("expenses")
      .select("metadata")
      .where("id", "=", expenseId)
      .executeTakeFirst();

    if (!row) throw new ExpenseError(`Expense ${expenseId} not found`);

    await trx
      .updateTable("expenses")
      .set({
        metadata: serializeMetadata({
          ...parseMetadata(row.metadata),
          ...patch,
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
 */
export async function advanceRepeatSchedule(
  templateId: string,
  from: string,
  interval: RepeatInterval,
): Promise<boolean> {
  const result = await db
    .updateTable("expenses")
    .set({ next_repeat: nextOccurrence(from, interval) })
    .where("id", "=", templateId)
    .where("next_repeat", "=", from)
    .where("repeat_interval", "=", interval)
    .executeTakeFirst();

  return Number(result?.numUpdatedRows ?? 0) > 0;
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
    description: "Payment",
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
