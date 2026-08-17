/**
 * The one definition of "which expenses did you ask for".
 *
 * Shared by every list endpoint (all expenses, one group, one friend) and by the
 * CSV export, so a filter cannot mean one thing on a screen and something else
 * in a download. The endpoints differ only in what they scope to first; the
 * filters below are applied on top of that scope and never widen it.
 *
 * Deliberately absent: an amount range. Amounts are per-currency integers, so
 * "more than 50" has no meaning until someone says 50 of what, and inventing a
 * conversion to answer it would break rule 2. Add it when a real request
 * arrives, with a currency attached.
 */
import { sql, type Expression, type ExpressionBuilder, type ExpressionWrapper, type SqlBool } from "kysely";
import type { Database } from "../../db/types.ts";
import { isUlid } from "../../domain/ulid.ts";

export interface ExpenseFilters {
  /** Case-insensitive substring of the description. */
  q?: string;
  /** A group ULID, or `"none"` for expenses that belong to no group. */
  groupId?: string;
  /** Only expenses this person is also on. */
  friendId?: string;
  /** Inclusive, date-only or full ISO. */
  datedAfter?: string;
  datedBefore?: string;
  categoryId?: number;
  isPayment?: boolean;
}

/** Splitwise's "no group" bucket, spelled for a query string. */
export const NO_GROUP = "none";

/**
 * Reads filters off a query string, ignoring anything malformed.
 *
 * Ignoring rather than rejecting is deliberate for a list endpoint: a stale
 * bookmark with a category that no longer exists should show you your expenses,
 * not a validation error. The ids that decide *visibility* are still validated by
 * the routes themselves.
 */
export function parseExpenseFilters(query: Record<string, string | undefined>): ExpenseFilters {
  const filters: ExpenseFilters = {};

  const q = query.q?.trim();
  if (q) filters.q = q;

  const groupId = query.group_id?.trim();
  if (groupId === NO_GROUP || (groupId && isUlid(groupId))) filters.groupId = groupId;

  const friendId = query.friend_id?.trim();
  if (friendId && isUlid(friendId)) filters.friendId = friendId;

  const after = normaliseBound(query.dated_after);
  if (after) filters.datedAfter = after;

  const before = normaliseBound(query.dated_before, true);
  if (before) filters.datedBefore = before;

  const categoryId = Number(query.category_id);
  if (Number.isInteger(categoryId) && categoryId > 0) filters.categoryId = categoryId;

  if (query.is_payment === "true" || query.is_payment === "1") filters.isPayment = true;
  if (query.is_payment === "false" || query.is_payment === "0") filters.isPayment = false;

  return filters;
}

/**
 * Turns a date-only bound into something that compares correctly against a
 * stored full ISO timestamp.
 *
 * `date` is stored as `2026-03-01T00:00:00.000Z`, so a naive
 * `date <= '2026-03-01'` string comparison would exclude everything on the
 * closing day. The upper bound therefore becomes the end of that day.
 */
function normaliseBound(value: string | undefined, inclusiveEnd = false): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return inclusiveEnd ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/** True when nothing was asked for, so callers can skip the WHERE entirely. */
export function hasFilters(filters: ExpenseFilters): boolean {
  return Object.keys(filters).length > 0;
}

/**
 * The filters as a single WHERE callback.
 *
 * A callback rather than a chain of `.where()` calls on a passed-in query
 * builder, because Kysely's builder type is parameterised by every joined table
 * and threading that through a helper means either a pile of generics or an
 * `any`. This way the expression is typed against `expenses` and composes with
 * whatever else the caller has joined.
 */
export function expenseFilterWhere(filters: ExpenseFilters) {
  return (
    eb: ExpressionBuilder<Database, "expenses">,
  ): ExpressionWrapper<Database, "expenses", SqlBool> => {
    const conditions: Array<Expression<SqlBool>> = [];

    if (filters.q !== undefined) {
      // `instr` rather than LIKE: a plain substring search has no wildcards to
      // escape, so searching for "50%" or "a_b" finds those characters instead of
      // matching everything. `lower()` gives the ASCII case-insensitivity people
      // expect from a search box.
      conditions.push(
        sql<SqlBool>`instr(lower(expenses.description), lower(${filters.q})) > 0`,
      );
    }

    if (filters.groupId === NO_GROUP) {
      conditions.push(eb("expenses.group_id", "is", null));
    } else if (filters.groupId !== undefined) {
      conditions.push(eb("expenses.group_id", "=", filters.groupId));
    }

    if (filters.friendId !== undefined) {
      conditions.push(
        eb.exists(
          eb
            .selectFrom("expense_users as filter_friend")
            .select("filter_friend.user_id")
            .whereRef("filter_friend.expense_id", "=", "expenses.id")
            .where("filter_friend.user_id", "=", filters.friendId),
        ),
      );
    }

    if (filters.datedAfter !== undefined) {
      conditions.push(eb("expenses.date", ">=", filters.datedAfter));
    }
    if (filters.datedBefore !== undefined) {
      conditions.push(eb("expenses.date", "<=", filters.datedBefore));
    }
    if (filters.categoryId !== undefined) {
      conditions.push(eb("expenses.category_id", "=", filters.categoryId));
    }
    if (filters.isPayment !== undefined) {
      conditions.push(eb("expenses.is_payment", "=", filters.isPayment ? 1 : 0));
    }

    return eb.and(conditions);
  };
}
