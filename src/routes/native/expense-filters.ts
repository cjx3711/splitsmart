/**
 * The filters, as SQL.
 *
 * Shared by every list endpoint (all expenses, one group, one friend) and by the
 * CSV export, so a filter cannot mean one thing on a screen and something else in
 * a download. The endpoints differ only in what they scope to first; the filters
 * below are applied on top of that scope and never widen it.
 *
 * What a filter MEANS lives in src/domain/expense-query.ts, which is pure so the
 * offline mirror can apply the same rules in the browser. This file is only the
 * translation into Kysely, and the pair is why "no results offline, twelve
 * results online" cannot happen quietly.
 */
import { z } from "zod";
import { sql, type Expression, type ExpressionBuilder, type ExpressionWrapper, type SqlBool } from "kysely";
import type { Database } from "../../db/types.ts";
import { isUlid } from "../../domain/ulid.ts";
import {
  hasFilters,
  NO_GROUP,
  parseExpenseFilters as parseFilters,
  type ExpenseFilters,
} from "../../domain/expense-query.ts";

export { hasFilters, NO_GROUP };
export type { ExpenseFilters };

/**
 * Query-string fields the list endpoints accept. All optional strings, so a
 * stale bookmark cannot 400: parseExpenseFilters still ignores anything
 * malformed. Present so Hono RPC types the client's `query` argument.
 */
export const expenseListQuerySchema = z.object({
  q: z.string().optional(),
  group_id: z.string().optional(),
  friend_id: z.string().optional(),
  dated_after: z.string().optional(),
  dated_before: z.string().optional(),
  category_id: z.string().optional(),
  is_payment: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional(),
});

/** Reads filters off a query string, ignoring anything malformed. */
export function parseExpenseFilters(
  query: Record<string, string | undefined>,
): ExpenseFilters {
  return parseFilters(query, isUlid);
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
