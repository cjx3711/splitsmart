/**
 * Reading the mirror.
 *
 * Every function here returns the SAME SHAPE as the `/api/v1` endpoint it stands
 * in for. That is a deliberate constraint rather than laziness: it means the
 * screens do not know whether they are online, the money components and the
 * filter bar are untouched, and adding a page does not mean writing it twice.
 * If a shape here drifts from the server's, the symptom is a blank column on one
 * screen, so `web/src/api.ts` is the reference for all of them.
 *
 * BALANCES ARE DERIVED, NEVER STORED. Every figure below comes from running the
 * real `deriveRepayments` over the shares in the mirror, per expense, and then
 * summing per currency. That is the third decision in docs/OFFLINE.md and it is
 * not an optimisation to skip: a pairwise net taken from two people's paid/owed
 * on a three-way bill is wrong, and `expense_repayments` on the server is a
 * write-time cache (rule 4) rather than something to replicate.
 *
 * CURRENCIES ARE NEVER MIXED, exactly as on the server. Everything returns an
 * array per currency. The ≈ estimate the dashboard can show comes from live
 * Frankfurter rates and is display-only; with no network there is no estimate,
 * which is the honest outcome rather than a stale one.
 */
import { deriveRepayments } from "../../../src/domain/split.ts";
import { displayName } from "../../../src/domain/person.ts";
import {
  compareByLastExpense,
  lastSharedExpenseIdByUser,
} from "../../../src/domain/friend-recency.ts";
import { simplifyDebts } from "../../../src/domain/settle.ts";
import {
  csvDocument,
  type CsvExpenseRow,
} from "../../../src/domain/expense-csv.ts";
import {
  hasFilters,
  matchesFilters,
  type ExpenseFilters,
} from "../../../src/domain/expense-query.ts";
import {
  isRepeatInterval,
  seriesTemplateId,
  type RepeatInterval,
} from "../../../src/domain/recurring.ts";
import type {
  ApiUser,
  Comment,
  CurrencyAmount,
  ExpenseDetail,
  ExpenseQuery,
  ExpenseSummary,
  Friend,
  FriendBreakdown,
  Group,
  GroupMember,
} from "../api.ts";
import type { LocalDb, LocalExpense, SyncUser } from "./local.ts";
import { getMeta } from "./local.ts";

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * The filter bar's state, as the shared predicate wants it.
 *
 * `ExpenseQuery` (what the UI holds) and `ExpenseFilters` (what the predicate
 * takes) are the same seven fields under two names, because the query string is
 * the wire format and one of them normalises its date bounds. Converting here
 * rather than making the UI hold the normalised form keeps the date inputs
 * showing what the user typed.
 */
function toFilters(query: ExpenseQuery = {}): ExpenseFilters {
  return {
    ...(query.q?.trim() ? { q: query.q.trim() } : {}),
    ...(query.groupId ? { groupId: query.groupId } : {}),
    ...(query.friendId ? { friendId: query.friendId } : {}),
    ...(query.datedAfter ? { datedAfter: bound(query.datedAfter) } : {}),
    ...(query.datedBefore ? { datedBefore: bound(query.datedBefore, true) } : {}),
    ...(query.categoryId !== undefined ? { categoryId: query.categoryId } : {}),
    ...(query.isPayment !== undefined ? { isPayment: query.isPayment } : {}),
  };
}

/** Local re-spelling of `normaliseBound`, kept identical so the two agree. */
function bound(value: string, inclusiveEnd = false): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) {
    return inclusiveEnd ? `${value.trim()}T23:59:59.999Z` : `${value.trim()}T00:00:00.000Z`;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function keep(expense: LocalExpense, filters: ExpenseFilters): boolean {
  if (!hasFilters(filters)) return true;
  return matchesFilters(
    {
      description: expense.description,
      groupId: expense.groupId,
      date: expense.date,
      categoryId: expense.categoryId,
      isPayment: expense.isPayment,
      participantIds: expense.shares.map((s) => s.userId),
    },
    filters,
  );
}

/** Newest first, then by id descending, exactly as every list endpoint orders. */
function byDateDesc(a: LocalExpense, b: LocalExpense): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/** Oldest first. A series is a timeline, so the starting bill sits at the top. */
function byDateAsc(a: LocalExpense, b: LocalExpense): number {
  return -byDateDesc(a, b);
}

// ---------------------------------------------------------------------------
// Balances
// ---------------------------------------------------------------------------

/** The live rows. A tombstone is kept for the undo but counts towards nothing. */
async function liveExpenses(db: LocalDb): Promise<LocalExpense[]> {
  const all = await db.expenses.toArray();
  return all.filter((e) => e.deletedAt === null);
}

interface Movement {
  fromUserId: string;
  toUserId: string;
  currencyCode: string;
  amountMinor: number;
  groupId: string | null;
}

/**
 * Every who-owes-whom in the mirror, one entry per repayment per expense.
 *
 * This is the server's `expense_repayments` table, recomputed on read instead of
 * replicated. It is cheap - a handful of participants per bill, arithmetic only -
 * and it means the mirror cannot hold a stale derivation, which is the failure
 * mode a replicated cache would have.
 */
function movements(expenses: LocalExpense[]): Movement[] {
  const result: Movement[] = [];

  for (const expense of expenses) {
    const repayments = deriveRepayments(
      expense.shares.map((s) => ({
        userId: s.userId,
        paidMinor: s.paidShareMinor,
        owedMinor: s.owedShareMinor,
        input: s.splitInput,
      })),
    );

    for (const r of repayments) {
      result.push({
        fromUserId: r.fromUserId,
        toUserId: r.toUserId,
        currencyCode: expense.currencyCode,
        amountMinor: r.amountMinor,
        groupId: expense.groupId,
      });
    }
  }

  return result;
}

/** Per-currency totals, zeroes dropped, sorted by code. Mirrors the SQL's HAVING. */
function toAmounts(totals: Map<string, number>): CurrencyAmount[] {
  return [...totals.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([currencyCode, amountMinor]) => ({ currencyCode, amountMinor }))
    .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}

/** Net position between the caller and everybody else. Positive = you are owed. */
function pairwise(moves: Movement[], selfId: string): Map<string, CurrencyAmount[]> {
  const byUser = new Map<string, Map<string, number>>();

  const add = (otherId: string, currency: string, amount: number) => {
    const totals = byUser.get(otherId) ?? new Map<string, number>();
    totals.set(currency, (totals.get(currency) ?? 0) + amount);
    byUser.set(otherId, totals);
  };

  for (const move of moves) {
    if (move.fromUserId === selfId) add(move.toUserId, move.currencyCode, -move.amountMinor);
    else if (move.toUserId === selfId) add(move.fromUserId, move.currencyCode, move.amountMinor);
  }

  const result = new Map<string, CurrencyAmount[]>();
  for (const [otherId, totals] of byUser) {
    const amounts = toAmounts(totals);
    if (amounts.length > 0) result.set(otherId, amounts);
  }
  return result;
}

/**
 * The same figures split out by the group each debt arose in.
 *
 * What lets the dashboard say "Grace owes you 74.02 USD for one-on-one expenses
 * and 6198 JPY for the Kyushu trip" rather than one opaque number. Summing a
 * person's buckets reproduces `pairwise` exactly.
 */
function pairwiseByGroup(
  moves: Movement[],
  selfId: string,
): Map<string, Array<{ groupId: string | null; balances: CurrencyAmount[] }>> {
  const buckets = new Map<string, Map<string, number>>();

  const add = (otherId: string, groupId: string | null, currency: string, amount: number) => {
    const key = `${otherId}|${groupId ?? ""}`;
    const totals = buckets.get(key) ?? new Map<string, number>();
    totals.set(currency, (totals.get(currency) ?? 0) + amount);
    buckets.set(key, totals);
  };

  for (const move of moves) {
    if (move.fromUserId === selfId) {
      add(move.toUserId, move.groupId, move.currencyCode, -move.amountMinor);
    } else if (move.toUserId === selfId) {
      add(move.fromUserId, move.groupId, move.currencyCode, move.amountMinor);
    }
  }

  const result = new Map<string, Array<{ groupId: string | null; balances: CurrencyAmount[] }>>();
  for (const [key, totals] of buckets) {
    const [otherId = "", rawGroup = ""] = key.split("|");
    const balances = toAmounts(totals);
    if (balances.length === 0) continue;
    const list = result.get(otherId) ?? [];
    list.push({ groupId: rawGroup === "" ? null : rawGroup, balances });
    result.set(otherId, list);
  }
  for (const list of result.values()) {
    list.sort((a, b) => {
      if (a.groupId === b.groupId) return 0;
      if (a.groupId === null) return 1;
      if (b.groupId === null) return -1;
      return a.groupId < b.groupId ? -1 : 1;
    });
  }
  return result;
}

/** Each member's net position inside one group. Sums to zero per currency. */
function groupBalances(moves: Movement[], groupId: string): Array<{ userId: string; balances: CurrencyAmount[] }> {
  const byUser = new Map<string, Map<string, number>>();

  const add = (userId: string, currency: string, amount: number) => {
    const totals = byUser.get(userId) ?? new Map<string, number>();
    totals.set(currency, (totals.get(currency) ?? 0) + amount);
    byUser.set(userId, totals);
  };

  for (const move of moves) {
    if (move.groupId !== groupId) continue;
    add(move.fromUserId, move.currencyCode, -move.amountMinor);
    add(move.toUserId, move.currencyCode, move.amountMinor);
  }

  const result: Array<{ userId: string; balances: CurrencyAmount[] }> = [];
  const userIds = [...byUser.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const userId of userIds) {
    const balances = toAmounts(byUser.get(userId)!);
    if (balances.length > 0) result.push({ userId, balances });
  }
  return result;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * Everyone the caller can see: explicit friendships, plus everyone they share a
 * live group membership or an expense with.
 *
 * The local half of `listRelatedUserIds`, and deliberately the same union. The
 * server has no row for a derived friend, so the client cannot replicate one; it
 * recomputes from the memberships and shares it already holds.
 */
async function relatedUserIds(db: LocalDb, selfId: string): Promise<Set<string>> {
  const ids = new Set<string>();

  for (const friendship of await db.friendships.toArray()) {
    const other = friendship.userAId === selfId ? friendship.userBId : friendship.userAId;
    if (other !== selfId) ids.add(other);
  }

  const myGroups = new Set(
    (await db.groupMembers.where("userId").equals(selfId).toArray())
      .filter((m) => m.leftAt === null)
      .map((m) => m.groupId),
  );
  for (const member of await db.groupMembers.toArray()) {
    if (!myGroups.has(member.groupId) || member.leftAt !== null) continue;
    if (member.userId !== selfId) ids.add(member.userId);
  }

  for (const expense of await db.expenses.toArray()) {
    if (!expense.shares.some((s) => s.userId === selfId)) continue;
    for (const share of expense.shares) {
      if (share.userId !== selfId) ids.add(share.userId);
    }
  }

  return ids;
}

// ---------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------

/** The cached profile. What lets the app render before `/auth/me` answers. */
export async function localProfile(db: LocalDb): Promise<ApiUser | null> {
  const profile = await getMeta(db, "profile");
  if (!profile) return null;
  return {
    id: profile.id,
    email: profile.email,
    name: profile.name,
    nickname: profile.nickname,
    iconLetters: profile.iconLetters,
    iconEmoji: profile.iconEmoji,
    iconHue: profile.iconHue,
    isGhost: profile.isGhost,
    defaultCurrency: profile.defaultCurrency,
    // isAdmin is live from /auth/me only — never cached in Dexie.
  };
}

export async function localGroups(
  db: LocalDb,
  selfId: string,
): Promise<{ groups: Group[]; totalBalance: CurrencyAmount[] }> {
  const memberships = (await db.groupMembers.where("userId").equals(selfId).toArray()).filter(
    (m) => m.leftAt === null,
  );
  const mine = new Set(memberships.map((m) => m.groupId));

  const groups = (await db.groups.toArray())
    .filter((g) => mine.has(g.id) && g.deletedAt === null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(toApiGroup);

  const moves = movements(await liveExpenses(db));
  const totals = new Map<string, number>();
  for (const balances of pairwise(moves, selfId).values()) {
    for (const b of balances) {
      totals.set(b.currencyCode, (totals.get(b.currencyCode) ?? 0) + b.amountMinor);
    }
  }

  return { groups, totalBalance: toAmounts(totals) };
}

function toApiGroup(group: { id: string; name: string; groupType: string; defaultCurrency: string; simplifyByDefault: boolean }): Group {
  return {
    id: group.id,
    name: group.name,
    group_type: group.groupType,
    default_currency: group.defaultCurrency,
    simplify_by_default: group.simplifyByDefault ? 1 : 0,
  };
}

export async function localGroup(
  db: LocalDb,
  selfId: string,
  groupId: string,
): Promise<{
  group: Group;
  members: GroupMember[];
  balances: Array<{ userId: string; balances: CurrencyAmount[] }>;
  role: string;
} | null> {
  const group = await db.groups.get(groupId);
  if (!group || group.deletedAt !== null) return null;

  const rows = await db.groupMembers.where("groupId").equals(groupId).toArray();
  const own = rows.find((m) => m.userId === selfId && m.leftAt === null);
  if (!own) return null;

  const members: GroupMember[] = rows
    .filter((m) => m.leftAt === null)
    .map((m) => ({
      id: m.userId,
      name: m.user?.name ?? "",
      nickname: m.user?.nickname ?? null,
      icon_letters: m.user?.iconLetters ?? null,
      icon_emoji: m.user?.iconEmoji ?? null,
      icon_hue: m.user?.iconHue ?? null,
      is_ghost: m.user?.isGhost ? 1 : 0,
      role: m.role,
      joined_via: m.joinedVia,
    }));

  return {
    group: toApiGroup(group),
    members,
    balances: groupBalances(movements(await liveExpenses(db)), groupId),
    role: own.role,
  };
}

/**
 * Suggested settle-up transfers, per currency.
 *
 * The same greedy matching the server runs, on the same numbers, through the same
 * pure function. `simplifyDebts` throws if a currency does not net to zero, which
 * would mean the mirror is inconsistent; that is worth surfacing rather than
 * papering over, so the error is left to propagate.
 */
export async function localSettleSuggestions(
  db: LocalDb,
  groupId: string,
): Promise<{
  suggestions: Array<{
    currencyCode: string;
    transfers: Array<{ fromUserId: string; toUserId: string; amountMinor: number }>;
  }>;
}> {
  const balances = groupBalances(movements(await liveExpenses(db)), groupId);
  const byCurrency = new Map<string, Array<{ userId: string; amountMinor: number }>>();

  for (const member of balances) {
    for (const b of member.balances) {
      const list = byCurrency.get(b.currencyCode) ?? [];
      list.push({ userId: member.userId, amountMinor: b.amountMinor });
      byCurrency.set(b.currencyCode, list);
    }
  }

  return {
    suggestions: [...byCurrency.entries()].map(([currencyCode, entries]) => ({
      currencyCode,
      transfers: simplifyDebts(entries),
    })),
  };
}

export async function localFriends(
  db: LocalDb,
  selfId: string,
): Promise<{ friends: Friend[] }> {
  const ids = await relatedUserIds(db, selfId);
  if (ids.size === 0) return { friends: [] };

  const expenses = await liveExpenses(db);
  const moves = movements(expenses);
  const balances = pairwise(moves, selfId);
  const breakdowns = pairwiseByGroup(moves, selfId);
  const lastByUser = lastSharedExpenseIdByUser(expenses, selfId);

  const explicit = new Set(
    (await db.friendships.toArray()).map((f) =>
      f.userAId === selfId ? f.userBId : f.userAId,
    ),
  );

  const groupNames = new Map((await db.groups.toArray()).map((g) => [g.id, g.name]));

  const users = (await db.users.bulkGet([...ids])).filter(
    (u): u is SyncUser => u !== undefined && u.deletedAt === null,
  );

  // Same order as GET /api/v1/friends: last shared expense, then name.
  const friends = users
    .sort((a, b) =>
      compareByLastExpense(a.id, b.id, lastByUser, displayName(a), displayName(b)),
    )
    .map((user) => toApiFriend(user, balances, breakdowns, explicit, groupNames));

  return { friends };
}

export async function localFriend(
  db: LocalDb,
  selfId: string,
  friendId: string,
): Promise<{ friend: Friend } | null> {
  const ids = await relatedUserIds(db, selfId);
  if (!ids.has(friendId)) return null;

  const user = await db.users.get(friendId);
  if (!user || user.deletedAt !== null) return null;

  const moves = movements(await liveExpenses(db));
  const explicit = new Set(
    (await db.friendships.toArray()).map((f) =>
      f.userAId === selfId ? f.userBId : f.userAId,
    ),
  );
  const groupNames = new Map((await db.groups.toArray()).map((g) => [g.id, g.name]));

  return {
    friend: toApiFriend(
      user,
      pairwise(moves, selfId),
      pairwiseByGroup(moves, selfId),
      explicit,
      groupNames,
    ),
  };
}

function toApiFriend(
  user: SyncUser,
  balances: Map<string, CurrencyAmount[]>,
  breakdowns: Map<string, Array<{ groupId: string | null; balances: CurrencyAmount[] }>>,
  explicit: Set<string>,
  groupNames: Map<string, string>,
): Friend {
  const breakdown: FriendBreakdown[] = (breakdowns.get(user.id) ?? [])
    .map((entry) => ({
      groupId: entry.groupId,
      // Null name means "one-on-one expenses"; the UI supplies that wording, so
      // the server does not invent a pseudo-group and neither does this.
      groupName: entry.groupId === null ? null : (groupNames.get(entry.groupId) ?? null),
      balances: entry.balances,
    }))
    .sort(byGroupName);

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    nickname: user.nickname,
    icon_letters: user.iconLetters,
    icon_emoji: user.iconEmoji,
    icon_hue: user.iconHue,
    is_ghost: user.isGhost ? 1 : 0,
    // Only explicit friendships can be removed. The derived ones come from shared
    // groups and expenses and would reappear on the next load.
    is_explicit: explicit.has(user.id),
    balances: balances.get(user.id) ?? [],
    breakdown,
  };
}

function byGroupName(a: { groupName: string | null }, b: { groupName: string | null }): number {
  if (a.groupName === b.groupName) return 0;
  if (a.groupName === null) return 1;
  if (b.groupName === null) return -1;
  return a.groupName.localeCompare(b.groupName);
}

/** The caller's own expenses, group and one-on-one alike. Backs All Expenses. */
export async function localExpenses(
  db: LocalDb,
  selfId: string,
  query: ExpenseQuery = {},
): Promise<{ expenses: ExpenseSummary[] }> {
  const filters = toFilters(query);
  const rows = (await liveExpenses(db))
    .filter((e) => e.shares.some((s) => s.userId === selfId) && keep(e, filters))
    .sort(byDateDesc);

  return { expenses: await toSummaries(db, rows) };
}

export async function localGroupExpenses(
  db: LocalDb,
  groupId: string,
  query: ExpenseQuery = {},
): Promise<{ expenses: ExpenseSummary[] }> {
  const filters = toFilters(query);
  // Filters narrow the group scope, never widen it: a `groupId` filter naming a
  // different group returns nothing rather than that group's expenses, same as
  // the server.
  const rows = (await liveExpenses(db))
    .filter((e) => e.groupId === groupId && keep(e, filters))
    .sort(byDateDesc);

  return { expenses: await toSummaries(db, rows) };
}

/** Both of you on the same bill, across every group plus the one-on-one ones. */
export async function localFriendExpenses(
  db: LocalDb,
  selfId: string,
  friendId: string,
  query: ExpenseQuery = {},
): Promise<{ expenses: ExpenseSummary[] }> {
  const filters = toFilters(query);
  const rows = (await liveExpenses(db))
    .filter(
      (e) =>
        e.shares.some((s) => s.userId === selfId) &&
        e.shares.some((s) => s.userId === friendId) &&
        keep(e, filters),
    )
    .sort(byDateDesc);

  return { expenses: await toSummaries(db, rows) };
}

async function toSummaries(db: LocalDb, rows: LocalExpense[]): Promise<ExpenseSummary[]> {
  if (rows.length === 0) return [];

  const categories = new Map((await db.categories.toArray()).map((c) => [c.id, c.name]));
  const groups = new Map((await db.groups.toArray()).map((g) => [g.id, g.name]));
  const counts = await commentCounts(db, rows.map((r) => r.id));

  return rows.map((row) => ({
    id: row.id,
    description: row.description,
    cost_minor: row.costMinor,
    currency_code: row.currencyCode,
    date: row.date,
    is_payment: row.isPayment ? 1 : 0,
    split_type: row.splitType,
    category_name: row.categoryId === null ? null : (categories.get(row.categoryId) ?? null),
    group_id: row.groupId,
    group_name: row.groupId === null ? null : (groups.get(row.groupId) ?? null),
    comment_count: counts.get(row.id) ?? 0,
    repeat_interval: row.repeatInterval,
    repeat_of: row.repeatOf,
    deleted_at: row.deletedAt,
    shares: row.shares.map((s) => ({
      user_id: s.userId,
      paid_share_minor: s.paidShareMinor,
      owed_share_minor: s.owedShareMinor,
      expense_id: row.id,
    })),
    split_meta: row.splitMeta,
    syncState: row.syncState,
  }));
}

/**
 * Every bill in the series this expense belongs to: the template plus the
 * copies that point at it, oldest first, including tombstones.
 *
 * Returns null when the id is unknown or is not part of a series. A deleted
 * template still returns the bills it already made, with `stopped` set - that
 * is the state deleting the first bill produces, and the series page has to
 * show it rather than 404.
 */
export async function localSeries(
  db: LocalDb,
  expenseId: string,
): Promise<{
  templateId: string;
  title: string;
  groupId: string | null;
  groupName: string | null;
  interval: RepeatInterval | null;
  nextRepeat: string | null;
  /** Why new bills are not coming. Null while the schedule is still live. */
  stoppedReason: "deleted" | "ended" | null;
  bills: ExpenseSummary[];
} | null> {
  const seed = await db.expenses.get(expenseId);
  if (!seed) return null;

  let templateId = seriesTemplateId(
    seed.id,
    seed.repeatOf,
    seed.repeatInterval,
    seed.repeatPaused,
  );
  if (!templateId) {
    const child = await db.expenses.where("repeatOf").equals(seed.id).first();
    if (child) templateId = seed.id;
  }
  if (!templateId) return null;

  const template = await db.expenses.get(templateId);
  const children = await db.expenses.where("repeatOf").equals(templateId).toArray();
  const rows = [...(template ? [template] : []), ...children].sort(byDateAsc);
  const head = template ?? seed;
  const interval = isRepeatInterval(head.repeatInterval)
    ? head.repeatInterval
    : isRepeatInterval(head.repeatPaused)
      ? head.repeatPaused
      : null;
  const stoppedReason: "deleted" | "ended" | null =
    !template || template.deletedAt !== null
      ? "deleted"
      : head.repeatInterval === null
        ? "ended"
        : null;

  const group = head.groupId === null ? null : await db.groups.get(head.groupId);

  return {
    templateId,
    title: head.isPayment ? "Settle up" : head.description,
    groupId: head.groupId,
    groupName: group?.name ?? null,
    interval,
    nextRepeat: stoppedReason ? null : (template?.nextRepeat ?? null),
    stoppedReason,
    bills: await toSummaries(db, rows),
  };
}

async function commentCounts(db: LocalDb, expenseIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const wanted = new Set(expenseIds);
  for (const comment of await db.comments.toArray()) {
    if (comment.deletedAt !== null || !wanted.has(comment.expenseId)) continue;
    counts.set(comment.expenseId, (counts.get(comment.expenseId) ?? 0) + 1);
  }
  return counts;
}

/**
 * One expense in full.
 *
 * Returns a tombstone rather than null when `deletedAt` is set, which the server
 * route does not: the expense page has to be able to render the undo, and it is
 * the only screen that can. `deleted_at` travels so the page knows which it has.
 */
export async function localExpense(
  db: LocalDb,
  id: string,
): Promise<{ expense: ExpenseDetail & { deleted_at: string | null } } | null> {
  const row = await db.expenses.get(id);
  if (!row) return null;

  const category = row.categoryId === null ? null : await db.categories.get(row.categoryId);
  const group = row.groupId === null ? null : await db.groups.get(row.groupId);

  // The template's id plus `repeatOf` IS the bundle; there is no bundle table.
  const seriesCount =
    row.repeatInterval === null && !row.repeatPaused
      ? 0
      : (await db.expenses.where("repeatOf").equals(id).toArray()).filter(
          (e) => e.deletedAt === null,
        ).length;

  return {
    expense: {
      id: row.id,
      description: row.description,
      details: row.details,
      cost_minor: row.costMinor,
      currency_code: row.currencyCode,
      date: row.date,
      is_payment: row.isPayment ? 1 : 0,
      split_type: row.splitType as ExpenseDetail["split_type"],
      split_meta: row.splitMeta,
      category_id: row.categoryId,
      category_name: category?.name ?? null,
      group_id: row.groupId,
      group_name: group?.name ?? null,
      repeat_interval: row.repeatInterval as ExpenseDetail["repeat_interval"],
      next_repeat: row.nextRepeat,
      repeat_of: row.repeatOf,
      repeat_paused: isRepeatInterval(row.repeatPaused) ? row.repeatPaused : null,
      series_count: seriesCount,
      version: row.version,
      deleted_at: row.deletedAt,
      shares: row.shares.map((s) => ({
        user_id: s.userId,
        paid_share_minor: s.paidShareMinor,
        owed_share_minor: s.owedShareMinor,
        split_input: s.splitInput,
      })),
    },
  };
}

/** The thread, oldest first: a conversation reads downwards. */
export async function localComments(
  db: LocalDb,
  expenseId: string,
): Promise<{ comments: Comment[] }> {
  const rows = (await db.comments.where("expenseId").equals(expenseId).toArray())
    .filter((c) => c.deletedAt === null)
    .sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id < b.id
          ? -1
          : 1
        : a.createdAt < b.createdAt
          ? -1
          : 1,
    );

  return {
    comments: rows.map((row) => ({
      id: row.id,
      expenseId: row.expenseId,
      kind: row.kind as Comment["kind"],
      content: row.content,
      createdAt: row.createdAt,
      author: {
        id: row.userId,
        name: row.author?.name ?? "",
        nickname: row.author?.nickname ?? null,
        iconLetters: row.author?.iconLetters ?? null,
        iconEmoji: row.author?.iconEmoji ?? null,
        iconHue: row.author?.iconHue ?? null,
      },
    })),
  };
}

/**
 * The CSV, built from the mirror.
 *
 * Goes through the same `csvDocument` the server calls, on rows gathered the same
 * way, so the download is byte-identical whether or not the network was up. A
 * second formatter here would eventually disagree about quoting or about which
 * currency's decimals to use, and nobody would notice until a spreadsheet did.
 */
export async function localExpenseCsv(
  db: LocalDb,
  selfId: string,
  query: ExpenseQuery = {},
): Promise<string> {
  const { expenses } = await localExpenses(db, selfId, query);
  if (expenses.length === 0) return csvDocument([]);

  const byId = new Map((await db.expenses.bulkGet(expenses.map((e) => e.id))).map((e) => [e?.id, e]));
  const currencies = new Map((await db.currencies.toArray()).map((c) => [c.code, c.decimalPlaces]));
  const users = new Map((await db.users.toArray()).map((u) => [u.id, u]));

  const rows: CsvExpenseRow[] = expenses.map((summary) => {
    const row = byId.get(summary.id);
      const decimals = currencies.get(summary.currency_code);
      if (decimals === undefined) {
        throw new Error(`Unknown currency ${summary.currency_code}`);
      }
      return {
      date: summary.date,
      description: summary.description,
      categoryName: summary.category_name,
      groupName: summary.group_name ?? null,
      currencyCode: summary.currency_code,
      costMinor: summary.cost_minor,
      decimalPlaces: decimals,
      isPayment: summary.is_payment === 1,
      details: row?.details ?? null,
      commentCount: summary.comment_count ?? 0,
      repeatInterval: summary.repeat_interval ?? null,
      repeatOf: summary.repeat_of ?? null,
      people: summary.shares.map((share) => {
        const user = users.get(share.user_id);
        return {
          name: user ? displayName(user) : share.user_id,
          paidMinor: share.paid_share_minor,
          owedMinor: share.owed_share_minor,
        };
      }),
    };
  });

  return csvDocument(rows);
}
