/**
 * Every expense you're a participant of, group and one-on-one alike.
 *
 * Names come from the friends list because an expense can involve people from
 * several groups at once and there is no single member roster to read from.
 */
import { useEffect, useState } from "react";
import { api, type ExpenseSummary, type Friend } from "../api.ts";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { useAuth } from "../App.tsx";

export function AllExpenses() {
  const { user } = useAuth();
  const [expenses, setExpenses] = useState<ExpenseSummary[] | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [list, friendList] = await Promise.all([api.listExpenses(), api.listFriends()]);
      setExpenses(list.expenses);
      setFriends(friendList.friends);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load expenses");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (error) return <p className="error">{error}</p>;
  if (!expenses || !user) return <p className="muted">Loading…</p>;

  const nameOf = makeLookup(friends, user.id);

  return (
    <>
      <div className="page-head">
        <h1>All expenses</h1>
      </div>
      <ExpenseList
        expenses={expenses}
        currentUserId={user.id}
        nameOf={nameOf}
        showGroup
        empty="You haven't split anything yet."
      />
    </>
  );
}
