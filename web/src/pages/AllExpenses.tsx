/**
 * Every expense you're a participant of, group and one-on-one alike.
 *
 * Names come from the friends list because an expense can involve people from
 * several groups at once and there is no single member roster to read from.
 *
 * Read from the offline mirror, and filtered over ALL of it rather than over a
 * fetched page - the cap that used to make local filtering dishonest is gone
 * along with the fetch. The rules are the server's own (docs/OFFLINE.md).
 */
import { useState } from "react";
import { type ExpenseQuery } from "../api.ts";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { ExpenseFilters } from "../ExpenseFilters.tsx";
import { useAuth } from "../App.tsx";
import { useExpenses, useFriends, useGroups, useMirrorReady } from "../localData.ts";

export function AllExpenses() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<ExpenseQuery>({});

  const expenses = useExpenses(filters)?.expenses ?? null;
  const friends = useFriends()?.friends ?? [];
  const groups = useGroups()?.groups ?? [];
  const ready = useMirrorReady();

  if (!user) return <p className="muted">Loading…</p>;

  const nameOf = makeLookup(friends, user.id);
  const filtering = Object.keys(filters).length > 0;

  return (
    <>
      <div className="page-head">
        <h1>All expenses</h1>
      </div>

      <ExpenseFilters
        value={filters}
        onChange={setFilters}
        groups={groups}
        people={friends}
        csvFilename="splitsmart-expenses"
      />

      {expenses === null ? (
        <p className="muted">Loading…</p>
      ) : (
        <ExpenseList
          expenses={expenses}
          currentUserId={user.id}
          nameOf={nameOf}
          showGroup
          empty={
            filtering
              ? "Nothing matches those filters."
              : ready
                ? "You haven't split anything yet."
                : "Waiting for the first sync."
          }
        />
      )}
    </>
  );
}
