/**
 * Every expense you're a participant of, group and one-on-one alike.
 *
 * Names come from the related-people roster (no balances) because an expense
 * can involve people from several groups at once.
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
import { useExpenses, useGroups, useMirrorReady, useRelatedPeople } from "../localData.ts";
import { Skeleton } from "../Skeleton.tsx";

export function AllExpenses() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<ExpenseQuery>({});

  const expenses = useExpenses(filters)?.expenses ?? null;
  const friends = useRelatedPeople()?.people ?? [];
  const groups = useGroups()?.groups ?? [];
  const ready = useMirrorReady();

  if (!user) return <Skeleton kind="expenses" />;

  const nameOf = makeLookup(friends, user.id);
  const filtering = Object.keys(filters).length > 0;
  const payers = [{ id: user.id, name: user.name, nickname: user.nickname }, ...friends];

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
        payers={payers}
        csvFilename="splitsmart-expenses"
      />

      {expenses === null ? (
        <Skeleton kind="expenseList" />
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
