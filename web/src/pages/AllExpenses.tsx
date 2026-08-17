/**
 * Every expense you're a participant of, group and one-on-one alike.
 *
 * Names come from the friends list because an expense can involve people from
 * several groups at once and there is no single member roster to read from.
 *
 * Filtering is server-side. The list is capped, so narrowing the rows already
 * fetched would search the most recent hundred expenses and call the rest
 * "no results".
 */
import { useEffect, useState } from "react";
import { api, type ExpenseQuery, type ExpenseSummary, type Friend, type Group } from "../api.ts";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { ExpenseFilters } from "../ExpenseFilters.tsx";
import { useAuth } from "../App.tsx";

export function AllExpenses() {
  const { user } = useAuth();
  const [expenses, setExpenses] = useState<ExpenseSummary[] | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [filters, setFilters] = useState<ExpenseQuery>({});
  const [error, setError] = useState<string | null>(null);

  // The reference data behind the filter bar's pickers, loaded once.
  useEffect(() => {
    void api.listFriends().then((r) => setFriends(r.friends)).catch(() => setFriends([]));
    void api.listGroups().then((r) => setGroups(r.groups)).catch(() => setGroups([]));
  }, []);

  useEffect(() => {
    let live = true;
    void api
      .listExpenses(filters)
      .then((r) => live && setExpenses(r.expenses))
      .catch((err) => {
        if (live) setError(err instanceof Error ? err.message : "Could not load expenses");
      });
    return () => {
      live = false;
    };
  }, [filters]);

  if (error) return <p className="error">{error}</p>;
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
              : "You haven't split anything yet."
          }
        />
      )}
    </>
  );
}
