/**
 * Recent activity.
 *
 * Reads the append-only `activity` table, which src/domain/expenses.ts has been
 * writing since day one and nothing was reading. Deleted expenses stay in the
 * feed; "X deleted an expense" is exactly the event people want to see.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type ActivityEntry } from "../api.ts";
import { Amount } from "../money.tsx";
import { Avatar } from "../Avatar.tsx";
import { useAuth } from "../App.tsx";

const VERBS: Record<string, string> = {
  "expense.created": "added",
  "expense.updated": "updated",
  "expense.deleted": "deleted",
  "expense.restored": "restored",
  "payment.created": "recorded a payment",
  "comment.created": "commented on",
  "comment.deleted": "deleted a comment on",
  "import.completed": "imported from Splitwise",
  "user.claimed": "claimed a placeholder person",
};

export function Activity() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);

  function load() {
    api
      .listActivity()
      .then((r) => setEntries(r.activity))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load activity"));
  }

  useEffect(load, []);

  /**
   * The way back from a delete you find later.
   *
   * The feed keeps deleted expenses ("X deleted an expense" is the event people
   * want to see), and the tombstone is still restorable, so the entry is the
   * natural place to undo one from. The server checks participation.
   */
  async function restore(expenseId: string) {
    setRestoring(expenseId);
    try {
      await api.restoreExpense(expenseId);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore that expense");
    } finally {
      setRestoring(null);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!entries) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="page-head">
        <h1>Recent activity</h1>
      </div>

      {entries.length === 0 ? (
        <p className="empty">Nothing has happened yet.</p>
      ) : (
        <div className="list">
          {entries.map((entry) => {
            const actorName =
              entry.actor === null
                ? "Someone"
                : entry.actor.id === user?.id
                  ? "You"
                  : [entry.actor.firstName, entry.actor.lastName].filter(Boolean).join(" ");
            const verb = VERBS[entry.action] ?? entry.action;

            return (
              <div key={entry.id} className="list-item">
                <Avatar id={entry.actor?.id ?? ""} name={actorName} size={30} />
                <div className="list-item-body">
                  <div>
                    <strong>{actorName}</strong> {verb}
                    {entry.expense && entry.action !== "payment.created" && (
                      <> “{entry.expense.description}”</>
                    )}
                    {entry.group && (
                      <>
                        {" "}
                        in <Link to={`/groups/${entry.group.id}`}>{entry.group.name}</Link>
                      </>
                    )}
                  </div>
                  <div className="muted">
                    {new Date(`${entry.createdAt.replace(" ", "T")}Z`).toLocaleString()}
                    {entry.expense?.deleted && " · this expense was later deleted"}
                    {entry.expense?.deleted && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="link"
                          onClick={() => void restore(entry.expense!.id)}
                          disabled={restoring === entry.expense.id}
                        >
                          {restoring === entry.expense.id ? "Restoring…" : "restore it"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {entry.expense && (
                  <Amount
                    minor={entry.expense.costMinor}
                    currency={entry.expense.currencyCode}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
