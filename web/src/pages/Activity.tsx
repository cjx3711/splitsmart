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
  "payment.created": "recorded a payment",
};

export function Activity() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listActivity()
      .then((r) => setEntries(r.activity))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load activity"));
  }, []);

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
