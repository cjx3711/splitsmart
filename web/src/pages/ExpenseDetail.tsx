/**
 * One expense: what it was, who paid, who owes what, plus the edit and
 * delete actions that used to live as a bare "✕" on every list row with no
 * confirmation and no way to fix a typo instead of redoing the whole thing.
 *
 * Delete does NOT navigate away any more. Deletes here have always been soft, and
 * now that there is a restore endpoint the honest thing is to stay on the page and
 * offer the undo, rather than bouncing to the group and leaving the tombstone
 * unreachable. Leaving the page is the user's next click, not ours.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, fullName, type ExpenseDetail as ExpenseDetailData, type Friend } from "../api.ts";
import { Amount } from "../money.tsx";
import { makeLookup } from "../ExpenseList.tsx";
import { EditExpenseDialog } from "../EditExpenseDialog.tsx";
import { CommentThread } from "../CommentThread.tsx";
import { RepeatNote } from "../RepeatNote.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { useAuth, useSidebarRefresh } from "../App.tsx";

export function ExpenseDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const refreshSidebar = useSidebarRefresh();

  const [expense, setExpense] = useState<ExpenseDetailData | null>(null);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  /** True between a delete and either the undo or navigating away. */
  const [deleted, setDeleted] = useState(false);

  async function load() {
    if (!id) return;
    try {
      const [detail, friendList] = await Promise.all([
        api.getExpense(id),
        api.listFriends(),
      ]);
      setExpense(detail.expense);
      setFriends(friendList.friends);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this expense");
    }
  }

  useEffect(() => {
    if (id) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when the id in the URL changes
  }, [id]);

  function back() {
    navigate(expense?.group_id ? `/groups/${expense.group_id}` : "/expenses");
  }

  async function handleDelete() {
    if (!id) return;
    setBusy(true);
    try {
      await api.deleteExpense(id);
      refreshSidebar();
      // The expense object stays in state deliberately: `GET /expenses/:id`
      // filters tombstones, so reloading now would 404 and there would be
      // nothing left on screen to undo from.
      setDeleted(true);
      setConfirmingDelete(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this expense");
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore() {
    if (!id) return;
    setBusy(true);
    try {
      await api.restoreExpense(id);
      refreshSidebar();
      setDeleted(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore this expense");
    } finally {
      setBusy(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!expense || !user) return <p className="muted">Loading…</p>;

  const nameOf = makeLookup(friends, user.id);
  const title = expense.is_payment === 1 ? "Settle up" : expense.description;

  // The group used to be repeated in the meta line below; the trail carries it
  // now, and one link per destination is enough.
  const trail = expense.group_id
    ? [
        { label: "Groups", to: "/groups" },
        { label: expense.group_name ?? "Group", to: `/groups/${expense.group_id}` },
        { label: title },
      ]
    : [{ label: "All expenses", to: "/expenses" }, { label: title }];

  return (
    <>
      <Breadcrumbs trail={trail} />

      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {expense.date.slice(0, 10)}
            {expense.category_name && ` · ${expense.category_name}`}
          </p>
        </div>
        <div className="page-actions">
          {!deleted && (
            <>
              <button className="secondary" onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
              <button onClick={() => setEditing(true)}>Edit</button>
            </>
          )}
        </div>
      </div>

      {deleted ? (
        <div className="notice stack">
          <strong>Deleted.</strong>
          <p style={{ margin: 0 }}>
            It is out of every balance it affected. Nothing was destroyed, so this can be undone.
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button onClick={() => void handleRestore()} disabled={busy}>
              {busy ? "Restoring…" : "Undo"}
            </button>
            <button className="secondary" onClick={back} disabled={busy}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <>
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
            <RepeatNote
              repeatInterval={expense.repeat_interval}
              nextRepeat={expense.next_repeat}
              repeatOf={expense.repeat_of}
              seriesCount={expense.series_count}
              templateHref={(templateId) => `/expenses/${templateId}`}
            />
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

          <CommentThread
            expenseId={expense.id}
            currentUserId={user.id}
            api={{
              list: api.listComments,
              add: api.addComment,
              remove: api.deleteComment,
            }}
          />
        </>
      )}

      <EditExpenseDialog
        expense={expense}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          setEditing(false);
          await load();
        }}
      />

      <ConfirmDialog
        open={confirmingDelete}
        title={`Delete "${title}"?`}
        confirmLabel="Delete expense"
        busyLabel="Deleting…"
        busy={busy}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={handleDelete}
      >
        <p style={{ margin: 0 }}>
          This takes it out of every balance it affects. You can undo it straight afterwards.
        </p>
      </ConfirmDialog>
    </>
  );
}
