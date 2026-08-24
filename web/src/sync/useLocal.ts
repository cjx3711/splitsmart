/**
 * Reading the mirror from a component.
 *
 * A thin wrapper over Dexie's `liveQuery`, which is the reason Dexie is here at
 * all: every screen re-renders when a sync lands, or when the user queues a write,
 * with no cache invalidation of our own and no refetch-on-focus logic. The old
 * `useEffect` + `api.x()` + `setState` shape had to be told when its data was
 * stale, and the answer was always "somewhere else in the tree".
 *
 * `undefined` means the query has not resolved yet - the same convention
 * `useLiveQuery` uses - and every caller distinguishes that from an empty result,
 * because "loading" and "you have no expenses" are very different screens.
 *
 * STALE RESULTS ARE DISCARDED. See `takeFresh` in fresh.ts: a snapshot whose
 * token is not this render's deps is treated as unresolved, so navigating from
 * one friend to another cannot paint the new expenses under the old name.
 */
import { useLiveQuery } from "dexie-react-hooks";
import { useLocalDb } from "./SyncProvider.tsx";
import type { LocalDb } from "../db/local.ts";
import { queryToken, takeFresh } from "./fresh.ts";

/**
 * Runs `query` against the mirror and re-runs it whenever the tables it touched
 * change.
 *
 * The db is passed in rather than closed over so the dependency list can stay
 * honest: `deps` names what the query reads from props or state, and the db itself
 * is tracked separately, so switching accounts re-runs everything.
 */
export function useLocal<T>(
  query: (db: LocalDb) => Promise<T>,
  deps: unknown[] = [],
): T | undefined {
  const db = useLocalDb();
  const token = queryToken(deps);

  const snapshot = useLiveQuery(
    async () => {
      if (!db) return undefined;
      return { token, value: await query(db) };
    },
    [db, token],
  );

  return takeFresh(snapshot, token);
}
