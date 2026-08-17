/**
 * Expense rows, shared by the group, friend and all-expenses screens.
 *
 * Shows each expense from the signed-in user's point of view: their own net
 * position on it (paid minus owed), which is the number people actually look
 * for. The cost sits next to it for context.
 *
 * The row itself opens the expense's own page, where editing and deleting
 * live - not here, and not behind a bare "✕" with no confirmation. The group
 * and payer names are their own links to that group's or friend's page, so
 * they need `stopPropagation` to keep the row underneath from also navigating.
 */
import { Link, useNavigate } from "react-router-dom";
import { Fragment } from "react";
import { fullName, type ExpenseSummary, type GroupMember } from "./api.ts";
import { Amount } from "./money.tsx";

export interface PersonLookup {
  (userId: number): string;
}

export function makeLookup(
  members: Array<GroupMember | { id: number; first_name: string; last_name: string | null }>,
  currentUserId: number,
): PersonLookup {
  const byId = new Map(members.map((m) => [m.id, m]));
  return (userId) => {
    if (userId === currentUserId) return "You";
    const member = byId.get(userId);
    return member ? fullName(member) : `User ${userId}`;
  };
}

export function ExpenseList({
  expenses,
  currentUserId,
  nameOf,
  showGroup = false,
  empty = "Nothing yet.",
}: {
  expenses: ExpenseSummary[];
  currentUserId: number;
  nameOf: PersonLookup;
  /** Label each row with the group it belongs to. */
  showGroup?: boolean;
  empty?: string;
}) {
  const navigate = useNavigate();

  if (expenses.length === 0) return <p className="empty">{empty}</p>;

  return (
    <div className="list">
      {expenses.map((expense) => {
        const mine = expense.shares.find((s) => s.user_id === currentUserId);
        const net = mine ? mine.paid_share_minor - mine.owed_share_minor : 0;
        const payers = expense.shares.filter((s) => s.paid_share_minor > 0);

        return (
          <div
            key={expense.id}
            className="list-item"
            role="link"
            tabIndex={0}
            style={{ cursor: "pointer" }}
            onClick={() => navigate(`/expenses/${expense.id}`)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(`/expenses/${expense.id}`);
            }}
          >
            <div className="list-item-body">
              <div className="list-item-title">
                {expense.is_payment === 1 ? "Settle up" : expense.description}
              </div>
              <div className="muted">
                {expense.date.slice(0, 10)}
                {showGroup && (
                  <>
                    {" · "}
                    {expense.group_id ? (
                      <Link to={`/groups/${expense.group_id}`} onClick={(e) => e.stopPropagation()}>
                        {expense.group_name}
                      </Link>
                    ) : (
                      "One-on-one"
                    )}
                  </>
                )}
                {expense.category_name && ` · ${expense.category_name}`}
                {payers.length > 0 && (
                  <>
                    {" · "}
                    {payers.map((p, i) => (
                      <Fragment key={p.user_id}>
                        {i > 0 && ", "}
                        {p.user_id === currentUserId ? (
                          nameOf(p.user_id)
                        ) : (
                          <Link to={`/friends/${p.user_id}`} onClick={(e) => e.stopPropagation()}>
                            {nameOf(p.user_id)}
                          </Link>
                        )}
                      </Fragment>
                    ))}{" "}
                    paid
                  </>
                )}
              </div>
            </div>

            <div style={{ textAlign: "right" }}>
              <div>
                <Amount minor={expense.cost_minor} currency={expense.currency_code} />
              </div>
              {net !== 0 && (
                <div className="muted" style={{ fontSize: "0.8rem" }}>
                  {net > 0 ? "you lent " : "you borrowed "}
                  <Amount minor={net} currency={expense.currency_code} absolute />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
