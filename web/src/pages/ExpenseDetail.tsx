/**
 * One expense: what it was, who paid, who owes what - plus the edit and
 * delete actions that used to live as a bare "✕" on every list row with no
 * confirmation and no way to fix a typo instead of redoing the whole thing.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api, fullName, type ExpenseDetail as ExpenseDetailData, type Friend } from "../api.ts";
import { Amount } from "../money.tsx";
import { makeLookup } from "../ExpenseList.tsx";
import { EditExpenseDialog } from "../EditExpenseDialog.tsx";
import { Modal } from "../Modal.tsx";
import { useAuth, useSidebarRefresh } from "../App.tsx";

export function ExpenseDetail() {
  const { id } = useParams<{ id: string }>();
  const expenseId = Number(id);
  const { user } = useAuth();
  const navigate = useNavigate();
  const refreshSidebar = useSidebarRefresh();

  const [expense, setExpense] = useState<ExpenseDetailData | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function load() {
    try {
      const [detail, friendList] = await Promise.all([
        api.getExpense(expenseId),
        api.listFriends(),
      ]);
      setExpense(detail.expense);
      setFriends(friendList.friends);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this expense");
    }
  }

  useEffect(() => {
    if (Number.isInteger(expenseId)) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the id in the URL changes
  }, [expenseId]);

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.deleteExpense(expenseId);
      refreshSidebar();
      navigate(expense?.group_id ? `/groups/${expense.group_id}` : "/expenses");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this expense");
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!expense || !user) return <p className="muted">Loading…</p>;

  const nameOf = makeLookup(friends, user.id);
  const title = expense.is_payment === 1 ? "Settle up" : expense.description;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {expense.date.slice(0, 10)}
            {expense.group_id && (
              <>
                {" · "}
                <Link to={`/groups/${expense.group_id}`}>{expense.group_name}</Link>
              </>
            )}
            {expense.category_name && ` · ${expense.category_name}`}
          </p>
        </div>
        <div className="page-actions">
          <button className="secondary" onClick={() => setConfirmingDelete(true)}>
            Delete
          </button>
          <button onClick={() => setEditing(true)}>Edit</button>
        </div>
      </div>

      <div className="card">
        <span className="eyebrow">Amount</span>
        <p style={{ margin: "0.4rem 0 0", fontSize: "1.5rem" }}>
          <Amount minor={expense.cost_minor} currency={expense.currency_code} />
        </p>
        {expense.details && (
          <p className="muted" style={{ marginBottom: 0 }}>
            {expense.details}
          </p>
        )}
      </div>

      <h2>Who paid, who owes</h2>
      <div className="list">
        {expense.shares.map((share) => (
          <div key={share.user_id} className="list-item">
            <div className="list-item-body">
              <div className="list-item-title">{nameOf(share.user_id)}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              {share.paid_share_minor > 0 && (
                <div className="muted">
                  paid <Amount minor={share.paid_share_minor} currency={expense.currency_code} />
                </div>
              )}
              <div>
                owes <Amount minor={share.owed_share_minor} currency={expense.currency_code} />
              </div>
            </div>
          </div>
        ))}
      </div>

      <EditExpenseDialog
        expense={expense}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          await load();
        }}
      />

      <Modal
        open={confirmingDelete}
        title={`Delete "${title}"?`}
        onClose={() => setConfirmingDelete(false)}
      >
        <div className="stack">
          <p style={{ margin: 0 }}>
            This removes it from every balance it affects. This can't be undone from here.
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              className="secondary"
              onClick={() => setConfirmingDelete(false)}
              disabled={deleting}
            >
              Cancel
            </button>
            <button onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete expense"}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
