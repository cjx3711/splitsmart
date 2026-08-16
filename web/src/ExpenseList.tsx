/**
 * Expense rows, shared by the group, friend and all-expenses screens.
 *
 * Shows each expense from the signed-in user's point of view: their own net
 * position on it (paid minus owed), which is the number people actually look
 * for. The cost sits next to it for context.
 */
import { api, fullName, type ExpenseSummary, type GroupMember } from "./api.ts";
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
  onDeleted,
  empty = "Nothing yet.",
}: {
  expenses: ExpenseSummary[];
  currentUserId: number;
  nameOf: PersonLookup;
  /** Label each row with the group it belongs to. */
  showGroup?: boolean;
  onDeleted?: () => void;
  empty?: string;
}) {
  if (expenses.length === 0) return <p className="empty">{empty}</p>;

  return (
    <div className="list">
      {expenses.map((expense) => {
        const mine = expense.shares.find((s) => s.user_id === currentUserId);
        const net = mine ? mine.paid_share_minor - mine.owed_share_minor : 0;
        const payers = expense.shares.filter((s) => s.paid_share_minor > 0);

        return (
          <div key={expense.id} className="list-item">
            <div className="list-item-body">
              <div className="list-item-title">
                {expense.is_payment === 1 ? "Settle up" : expense.description}
              </div>
              <div className="muted">
                {expense.date.slice(0, 10)}
                {showGroup && ` · ${expense.group_name ?? "One-on-one"}`}
                {expense.category_name && ` · ${expense.category_name}`}
                {payers.length > 0 && ` · ${payers.map((p) => nameOf(p.user_id)).join(", ")} paid`}
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

            {onDeleted && (
              <button
                className="icon"
                title="Delete expense"
                aria-label={`Delete ${expense.description}`}
                onClick={() => {
                  void api.deleteExpense(expense.id).then(onDeleted).catch(() => {});
                }}
              >
                ✕
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
