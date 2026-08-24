/**
 * Last shared expense per friend and per group, for rail sort.
 *
 * Balances stay derived (docs/OFFLINE.md). This is only "which bill is newest",
 * which the expense ULID already is. The sidebar used to re-derive every net
 * on the ledger to get that order; the maps here are enough.
 *
 * Keyed by user id (`splitsmart:<userId>:friend-recency`) so two accounts on
 * one browser keep separate maps. The Dexie mirror is already
 * `splitsmart-<userId>`. A delete that was someone's (or a group's) latest
 * bill returns null from `applyTouchedExpenses` and the caller rebuilds.
 */
import { lastSharedExpenseIdByUser } from "../../../src/domain/friend-recency.ts";
import { isImportRoundingExpense } from "../../../src/domain/metadata.ts";

export const FRIEND_RECENCY_VERSION = 2;

export type FriendRecencyMap = Record<string, string>;

export interface FriendRecencyCache {
  v: typeof FRIEND_RECENCY_VERSION;
  /** userId → newest live, non-rounding expense id both people are on. */
  last: FriendRecencyMap;
  /** groupId → newest live, non-rounding expense id in that group. */
  lastByGroup: FriendRecencyMap;
  /** Derived + explicit related ids seen so far. Grows on new bills. */
  related: string[];
}

type TouchedExpense = {
  id: string;
  shares: ReadonlyArray<{ userId: string }>;
  groupId?: string | null;
  deletedAt?: string | null;
  details?: string | null;
  importRounding?: boolean;
};

export function friendRecencyKey(userId: string): string {
  return `splitsmart:${userId}:friend-recency`;
}

export function lastExpenseIdByGroup(
  expenses: ReadonlyArray<TouchedExpense>,
): Map<string, string> {
  const last = new Map<string, string>();
  for (const expense of expenses) {
    if (expense.deletedAt || !expense.groupId || isImportRoundingExpense(expense)) continue;
    const prev = last.get(expense.groupId);
    if (prev === undefined || expense.id > prev) last.set(expense.groupId, expense.id);
  }
  return last;
}

export function loadFriendRecency(userId: string): FriendRecencyCache | null {
  try {
    const raw = localStorage.getItem(friendRecencyKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as FriendRecencyCache;
    if (
      parsed.v !== FRIEND_RECENCY_VERSION ||
      !parsed.last ||
      !parsed.lastByGroup ||
      !parsed.related
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveFriendRecency(userId: string, cache: FriendRecencyCache): void {
  localStorage.setItem(friendRecencyKey(userId), JSON.stringify(cache));
}

export function clearFriendRecency(userId: string): void {
  localStorage.removeItem(friendRecencyKey(userId));
}

export function cacheFromExpenses(
  expenses: ReadonlyArray<TouchedExpense>,
  selfId: string,
  related: Iterable<string>,
): FriendRecencyCache {
  const live = expenses.filter((e) => !e.deletedAt);
  return {
    v: FRIEND_RECENCY_VERSION,
    last: Object.fromEntries(lastSharedExpenseIdByUser(live, selfId)),
    lastByGroup: Object.fromEntries(lastExpenseIdByGroup(live)),
    related: [...new Set(related)].filter((id) => id !== selfId).sort(),
  };
}

/**
 * Fold a batch of writes into the cache.
 *
 * Returns null when a tombstone was the stored latest bill for someone — the
 * next-newest id is not on the write, so the caller has to rebuild.
 */
export function applyTouchedExpenses(
  cache: FriendRecencyCache,
  touched: ReadonlyArray<TouchedExpense>,
  selfId: string,
): FriendRecencyCache | null {
  const last = { ...cache.last };
  const lastByGroup = { ...cache.lastByGroup };
  const related = new Set(cache.related);

  for (const expense of touched) {
    const groupId = expense.groupId ?? null;
    if (expense.deletedAt) {
      if (groupId && lastByGroup[groupId] === expense.id) return null;
    } else if (groupId && !isImportRoundingExpense(expense)) {
      const prevGroup = lastByGroup[groupId];
      if (prevGroup === undefined || expense.id > prevGroup) lastByGroup[groupId] = expense.id;
    }

    if (isImportRoundingExpense(expense)) continue;
    if (!expense.shares.some((s) => s.userId === selfId)) continue;
    const others = expense.shares.map((s) => s.userId).filter((id) => id !== selfId);
    for (const id of others) related.add(id);

    if (expense.deletedAt) {
      if (others.some((id) => last[id] === expense.id)) return null;
      continue;
    }

    for (const id of others) {
      const prev = last[id];
      if (prev === undefined || expense.id > prev) last[id] = expense.id;
    }
  }

  return {
    v: FRIEND_RECENCY_VERSION,
    last,
    lastByGroup,
    related: [...related].sort(),
  };
}
