/**
 * What "which expenses did you ask for" MEANS.
 *
 * PURE, and shared three ways. `src/routes/native/expense-filters.ts` turns these
 * into a Kysely WHERE for the server's list endpoints and the CSV export;
 * `web/src/db/queries.ts` runs `matchesFilters` over the offline mirror. Both have
 * to agree, because the same filter bar drives both and "no results offline,
 * twelve results online" is the kind of bug nobody reports as a bug.
 *
 * Same discipline as src/domain/split.ts: no I/O, no Kysely, so the browser can
 * import it and there is one definition rather than two that drift.
 *
 * Deliberately absent: an amount range. Amounts are per-currency integers, so
 * "more than 50" has no meaning until somebody says 50 of what, and inventing a
 * conversion to answer it would break rule 2.
 */

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

/** True when nothing was asked for, so callers can skip the filter entirely. */
export function hasFilters(filters: ExpenseFilters): boolean {
  return Object.keys(filters).length > 0;
}

/**
 * Turns a date-only bound into something that compares correctly against a
 * stored full ISO timestamp.
 *
 * `date` is stored as `2026-03-01T00:00:00.000Z`, so a naive
 * `date <= '2026-03-01'` string comparison would exclude everything on the
 * closing day. The upper bound therefore becomes the end of that day.
 */
export function normaliseBound(
  value: string | undefined,
  inclusiveEnd = false,
): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return inclusiveEnd ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * Reads filters off a query string or a form's state, ignoring anything malformed.
 *
 * Ignoring rather than rejecting is deliberate: a stale bookmark naming a category
 * that no longer exists should show you your expenses, not a validation error. The
 * ids that decide *visibility* are validated by the routes themselves.
 *
 * `isUlid` is injected rather than imported so this module stays free of even that
 * dependency; both callers already have it to hand.
 */
export function parseExpenseFilters(
  query: Record<string, string | undefined>,
  isUlid: (value: string) => boolean,
): ExpenseFilters {
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

/** The shape `matchesFilters` needs. Both a server row and a mirror document fit. */
export interface FilterableExpense {
  description: string;
  groupId: string | null;
  date: string;
  categoryId: number | null;
  isPayment: boolean;
  /** Everyone on the bill, for the `friendId` filter. */
  participantIds: string[];
}

/**
 * The offline half of the definition above.
 *
 * Matches `expenseFilterWhere`'s SQL clause for clause, including the two
 * choices that are easy to get wrong:
 *
 *   - `q` is a plain lowercased SUBSTRING, mirroring `instr(lower(...))` rather
 *     than LIKE, so searching for `50%` finds a percent sign instead of matching
 *     everything.
 *   - the bounds are already normalised (see `normaliseBound`) and compared as
 *     strings, exactly as SQLite compares them, so an ISO date sorts lexically
 *     and the closing day is included.
 */
export function matchesFilters(
  expense: FilterableExpense,
  filters: ExpenseFilters,
): boolean {
  if (filters.q !== undefined) {
    if (!expense.description.toLowerCase().includes(filters.q.toLowerCase())) return false;
  }

  if (filters.groupId === NO_GROUP) {
    if (expense.groupId !== null) return false;
  } else if (filters.groupId !== undefined) {
    if (expense.groupId !== filters.groupId) return false;
  }

  if (filters.friendId !== undefined && !expense.participantIds.includes(filters.friendId)) {
    return false;
  }

  if (filters.datedAfter !== undefined && expense.date < filters.datedAfter) return false;
  if (filters.datedBefore !== undefined && expense.date > filters.datedBefore) return false;
  if (filters.categoryId !== undefined && expense.categoryId !== filters.categoryId) return false;
  if (filters.isPayment !== undefined && expense.isPayment !== filters.isPayment) return false;

  return true;
}
