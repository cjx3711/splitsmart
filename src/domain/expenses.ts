/**
 * Expense writes.
 *
 * THIS IS THE ONLY MODULE ALLOWED TO WRITE `expenses`, `expense_users`, OR
 * `expense_repayments`. Everything else goes through these functions.
 *
 * The reason is the expense invariant from migrations/001: paid shares and owed
 * shares must each sum to the expense total, and expense_repayments must be a
 * faithful derivation of expense_users. SQLite cannot enforce either across
 * rows, so correctness depends on every write taking this path — inside one
 * transaction, with the split engine deciding the numbers.
 */
import { sql } from "kysely";
import type { DB } from "../db/index.ts";
import { transaction } from "../db/index.ts";
import {
  computeSplit,
  deriveRepayments,
  type SplitParticipant,
  type SplitType,
} from "./split.ts";

export interface CreateExpenseInput {
  groupId?: number | null;
  description: string;
  details?: string | null;
  costMinor: number;
  currencyCode: string;
  /** ISO-8601. Date-only input is normalised to midnight UTC. */
  date: string;
  categoryId?: number | null;
  splitType: SplitType;
  participants: SplitParticipant[];
  isPayment?: boolean;
  paymentMethod?: string | null;
  createdBy: number;
  /** Set only by the Splitwise importer to preserve original ids. */
  splitwiseId?: number | null;
}

export class ExpenseError extends Error {}

/**
 * Creates an expense with its shares and derived repayments, atomically.
 */
export async function createExpense(input: CreateExpenseInput): Promise<number> {
  const shares = computeSplit(input.costMinor, input.splitType, input.participants);
  const repayments = deriveRepayments(shares);
  const date = normaliseDate(input.date);

  return transaction(async (trx) => {
    await assertParticipantsAreMembers(trx, input.groupId ?? null, shares.map((s) => s.userId));

    const expense = await trx
      .insertInto("expenses")
      .values({
        splitwise_id: input.splitwiseId ?? null,
        group_id: input.groupId ?? null,
        description: input.description,
        details: input.details ?? null,
        cost_minor: input.costMinor,
        currency_code: input.currencyCode.toUpperCase(),
        date,
        category_id: input.categoryId ?? null,
        split_type: input.splitType,
        is_payment: input.isPayment ? 1 : 0,
        payment_method: input.paymentMethod ?? null,
        created_by: input.createdBy,
        updated_by: input.createdBy,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await writeSharesAndRepayments(trx, expense.id, shares, repayments);

    await trx
      .insertInto("activity")
      .values({
        user_id: input.createdBy,
        group_id: input.groupId ?? null,
        expense_id: expense.id,
        action: input.isPayment ? "payment.created" : "expense.created",
        payload: JSON.stringify({ description: input.description }),
      })
      .execute();

    return expense.id;
  });
}

/**
 * Replaces an expense's contents.
 *
 * Shares and repayments are deleted and rewritten rather than diffed — an
 * expense has a handful of rows, and a full rewrite cannot leave a stale
 * participant behind the way a partial update can.
 */
export async function updateExpense(
  expenseId: number,
  input: Omit<CreateExpenseInput, "createdBy" | "splitwiseId"> & { updatedBy: number },
): Promise<void> {
  const shares = computeSplit(input.costMinor, input.splitType, input.participants);
  const repayments = deriveRepayments(shares);
  const date = normaliseDate(input.date);

  await transaction(async (trx) => {
    const existing = await trx
      .selectFrom("expenses")
      .select(["id", "deleted_at"])
      .where("id", "=", expenseId)
      .executeTakeFirst();

    if (!existing) throw new ExpenseError(`Expense ${expenseId} not found`);
    if (existing.deleted_at) throw new ExpenseError(`Expense ${expenseId} is deleted`);

    await assertParticipantsAreMembers(trx, input.groupId ?? null, shares.map((s) => s.userId));

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
        is_payment: input.isPayment ? 1 : 0,
        payment_method: input.paymentMethod ?? null,
        updated_by: input.updatedBy,
        updated_at: new Date().toISOString().replace("T", " ").slice(0, 19),
      })
      .where("id", "=", expenseId)
      .execute();

    await trx.deleteFrom("expense_users").where("expense_id", "=", expenseId).execute();
    await trx.deleteFrom("expense_repayments").where("expense_id", "=", expenseId).execute();

    await writeSharesAndRepayments(trx, expenseId, shares, repayments);

    await trx
      .insertInto("activity")
      .values({
        user_id: input.updatedBy,
        group_id: input.groupId ?? null,
        expense_id: expenseId,
        action: "expense.updated",
        payload: JSON.stringify({ description: input.description }),
      })
      .execute();
  });
}

/**
 * Soft-deletes an expense.
 *
 * Repayment rows are left in place; every balance query filters on
 * `expenses.deleted_at IS NULL`, so a deleted expense stops affecting balances
 * without losing the history. The compat API needs `deleted_at` on the way out,
 * which is the other reason not to hard-delete.
 */
export async function deleteExpense(expenseId: number, deletedBy: number): Promise<void> {
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
        user_id: deletedBy,
        group_id: expense.group_id,
        expense_id: expenseId,
        action: "expense.deleted",
      })
      .execute();
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
  fromUserId: number;
  toUserId: number;
  amountMinor: number;
  currencyCode: string;
  groupId?: number | null;
  date?: string;
  paymentMethod?: string | null;
  createdBy: number;
}): Promise<number> {
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

async function writeSharesAndRepayments(
  trx: DB,
  expenseId: number,
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
  groupId: number | null,
  userIds: number[],
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
