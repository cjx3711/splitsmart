/**
 * The screens' data layer.
 *
 * Every hook here reads the MIRROR, not the network, and re-renders when the
 * mirror changes - a sync landing, or the user queuing a write. That is the whole
 * shape of the offline app: no page fetches, no refetch-on-focus, no cache to
 * invalidate, and no code path where being offline takes a screen away.
 *
 * Each returns exactly the shape the `/api/v1` endpoint it replaces returned
 * (web/src/db/queries.ts is where that is enforced), so converting a page meant
 * swapping one call rather than rewriting it. `undefined` means "not resolved
 * yet"; distinguishing that from an empty array matters, because "loading" and
 * "you have no expenses" are different screens.
 *
 * WHY NOT A NETWORK FALLBACK. There is deliberately no "read locally, else fetch"
 * here. Two sources of truth in the read path means two answers to every question
 * and a bug class where a screen shows one and the next shows the other; the sync
 * loop's job is to keep the one source current, and if it cannot, the status bar
 * says so out loud.
 */
import { useAuth } from "./App.tsx";
import { useLocal } from "./sync/useLocal.ts";
import { useSync } from "./sync/SyncProvider.tsx";
import {
  localComments,
  localExpense,
  localExpenses,
  localFriend,
  localFriendExpenses,
  localFriends,
  localGroup,
  localGroupExpenses,
  localGroupMembers,
  localGroups,
  localRelatedPeople,
  localSettleSuggestions,
  localSeries,
  localSharedGroups,
} from "./db/queries.ts";
import type { ExpenseQuery } from "./api.ts";

/**
 * Whether the first full bootstrap has finished.
 *
 * Screens use it to tell "you have nothing" from "we have not been told yet",
 * which on a fresh install with no network are the same empty list.
 */
export function useMirrorReady(): boolean {
  return useSync().status?.bootstrapped ?? false;
}

export function useGroups() {
  const { user } = useAuth();
  return useLocal((db) => (user ? localGroups(db, user.id) : Promise.resolve(undefined)), [
    user?.id,
  ]);
}

export function useFriends() {
  const { user } = useAuth();
  return useLocal((db) => (user ? localFriends(db, user.id) : Promise.resolve(undefined)), [
    user?.id,
  ]);
}

/** Names and recency only. The rail and pickers must not wait on balances. */
export function useRelatedPeople() {
  const { user } = useAuth();
  return useLocal((db) => (user ? localRelatedPeople(db, user.id) : Promise.resolve(undefined)), [
    user?.id,
  ]);
}

export function useFriend(friendId: string | undefined) {
  const { user } = useAuth();
  return useLocal(
    (db) =>
      user && friendId ? localFriend(db, user.id, friendId) : Promise.resolve(undefined),
    [user?.id, friendId],
  );
}

/** Groups both people currently belong to. Local-only; see `localSharedGroups`. */
export function useSharedGroups(friendId: string | undefined) {
  const { user } = useAuth();
  return useLocal(
    (db) =>
      user && friendId
        ? localSharedGroups(db, user.id, friendId)
        : Promise.resolve(undefined),
    [user?.id, friendId],
  );
}

/**
 * Current members of several groups at once, e.g. to show who else is on a
 * shared bill next to a per-group balance line. Keyed by group id; a groupId
 * list that is empty or all-null yields an empty map rather than a query.
 */
export function useGroupMembers(groupIds: Array<string | null>) {
  const ids = groupIds.filter((id): id is string => id !== null);
  const key = [...new Set(ids)].sort().join(",");
  return useLocal((db) => localGroupMembers(db, ids), [key]);
}

export function useGroupView(groupId: string | undefined) {
  const { user } = useAuth();
  return useLocal(
    (db) => (user && groupId ? localGroup(db, user.id, groupId) : Promise.resolve(undefined)),
    [user?.id, groupId],
  );
}

export function useExpenses(filters: ExpenseQuery) {
  const { user } = useAuth();
  // The filter object is rebuilt on every render, so the dependency is its
  // serialisation rather than its identity; otherwise the query re-runs forever.
  const key = JSON.stringify(filters);
  return useLocal(
    (db) => (user ? localExpenses(db, user.id, filters) : Promise.resolve(undefined)),
    [user?.id, key],
  );
}

export function useGroupExpenses(groupId: string | undefined, filters: ExpenseQuery) {
  const key = JSON.stringify(filters);
  return useLocal(
    (db) => (groupId ? localGroupExpenses(db, groupId, filters) : Promise.resolve(undefined)),
    [groupId, key],
  );
}

export function useFriendExpenses(friendId: string | undefined, filters: ExpenseQuery) {
  const { user } = useAuth();
  const key = JSON.stringify(filters);
  return useLocal(
    (db) =>
      user && friendId
        ? localFriendExpenses(db, user.id, friendId, filters)
        : Promise.resolve(undefined),
    [user?.id, friendId, key],
  );
}

export function useExpense(expenseId: string | undefined) {
  return useLocal(
    (db) => (expenseId ? localExpense(db, expenseId) : Promise.resolve(undefined)),
    [expenseId],
  );
}

export function useSeries(expenseId: string | undefined) {
  return useLocal(
    (db) => (expenseId ? localSeries(db, expenseId) : Promise.resolve(undefined)),
    [expenseId],
  );
}

export function useComments(expenseId: string | undefined) {
  return useLocal(
    (db) => (expenseId ? localComments(db, expenseId) : Promise.resolve(undefined)),
    [expenseId],
  );
}

export function useSettleSuggestions(groupId: string | undefined) {
  return useLocal(
    (db) => (groupId ? localSettleSuggestions(db, groupId) : Promise.resolve(undefined)),
    [groupId],
  );
}
