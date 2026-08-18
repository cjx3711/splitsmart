/**
 * One expense: what it was, who paid, who owes what, plus the edit and
 * delete actions that used to live as a bare "✕" on every list row with no
 * confirmation and no way to fix a typo instead of redoing the whole thing.
 *
 * Delete does NOT navigate away any more. Deletes here have always been soft, and
 * now that there is a restore endpoint the honest thing is to stay on the page and
 * offer the undo, rather than bouncing to the group and leaving the tombstone
 * unreachable. Leaving the page is the user's next click, not ours.
 *
 * Delete, undo, edit and commenting all go through the outbox, so all four work
 * with no network. The delete/undo pair is also the reason the mirror keeps
 * tombstones: `GET /expenses/:id` filters them and the local read deliberately
 * does not, because this is the only screen that can offer the undo.
 */
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Amount } from "../money.tsx";
import { makeLookup } from "../ExpenseList.tsx";
import { EditExpenseDialog } from "../EditExpenseDialog.tsx";
import { CommentThread } from "../CommentThread.tsx";
import { RepeatNote, seriesDeleteNote } from "../RepeatNote.tsx";
import { seriesTemplateId } from "../../../src/domain/recurring.ts";
import {
  ResumeRepeatingButton,
  ResumeSeriesDialog,
  StopRepeatingButton,
  StopSeriesDialog,
  useStopSeries,
} from "../stopSeries.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { SyncBadge } from "../SyncStatusBar.tsx";
import { useAuth } from "../App.tsx";
import { useExpense, useFriends } from "../localData.ts";
import { useSync } from "../sync/SyncProvider.tsx";
import { useLocal } from "../sync/useLocal.ts";
import { Avatar, avatarFromRow } from "../Avatar.tsx";
import { PersonLink } from "../PersonLink.tsx";

export function ExpenseDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const { engine } = useSync();

  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const loaded = useExpense(id);
  const friends = useFriends()?.friends ?? [];
  const local = useLocalExpenseRow(id);
  const templateId = loaded?.expense
    ? (seriesTemplateId(
        loaded.expense.id,
        loaded.expense.repeat_of,
        loaded.expense.repeat_interval,
        loaded.expense.repeat_paused,
      ) ?? undefined)
    : undefined;
  const stop = useStopSeries(templateId);

  if (loaded === undefined || !user) return <p className="muted">Loading…</p>;
  if (loaded === null) return <p className="empty">This expense is not on this device.</p>;

  const expense = loaded.expense;
  // The tombstone IS the state now, rather than a flag held next to a row the
  // server would refuse to hand back. The undo works offline for the same reason.
  const deleted = expense.deleted_at !== null;

  function back() {
    navigate(expense.group_id ? `/groups/${expense.group_id}` : "/expenses");
  }

  async function handleDelete() {
    if (!id) return;
    if (!engine) throw new Error("Not ready to save yet.");
    setBusy(true);
    try {
      await engine.enqueue({
        kind: "expense.delete",
        id,
        baseVersion: expense.version ?? 1,
      });
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
      // A local delete that never left the device folds away entirely - the
      // reducer drops both ops rather than sending a delete and an undo.
      if (!engine) throw new Error("Not ready to save yet.");
      await engine.enqueue({
        kind: "expense.restore",
        id,
        baseVersion: expense.version ?? 1,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not restore this expense");
    } finally {
      setBusy(false);
    }
  }

  const nameOf = makeLookup(friends, user.id);
  const avatarFor = (userId: string) => {
    if (userId === user.id) {
      return {
        id: user.id,
        name: user.name,
        nickname: user.nickname,
        iconLetters: user.iconLetters,
        iconEmoji: user.iconEmoji,
        iconHue: user.iconHue,
      };
    }
    const friend = friends.find((f) => f.id === userId);
    return friend ? avatarFromRow(friend) : { id: userId, name: nameOf(userId) };
  };
  const title = expense.is_payment === 1 ? "Settle up" : expense.description;
  const deleteSeriesNote = seriesDeleteNote(expense);

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
          <h1>
            {title} <SyncBadge state={local?.syncState} />
          </h1>
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

      {error && <p className="error">{error}</p>}

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
              repeatPaused={expense.repeat_paused}
              seriesCount={expense.series_count}
              seriesHref={`/expenses/${expense.id}/series`}
              stop={
                stop.live ? (
                  <StopRepeatingButton onClick={stop.requestStop} />
                ) : stop.paused ? (
                  <ResumeRepeatingButton onClick={stop.requestResume} />
                ) : undefined
              }
            />
          </div>

          <h2>Who paid, who owes</h2>
          <div className="list">
            {expense.shares.map((share) => (
              <div key={share.user_id} className="list-item">
                <Avatar {...avatarFor(share.user_id)} />
                <div className="list-item-body">
                  <div className="list-item-title">
                    <PersonLink userId={share.user_id} currentUserId={user.id}>
                      {nameOf(share.user_id)}
                    </PersonLink>
                  </div>
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

          <CommentThread expenseId={expense.id} currentUserId={user.id} />
        </>
      )}

      <EditExpenseDialog
        expense={expense}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={() => setEditing(false)}
      />

      <ConfirmDialog
        open={confirmingDelete}
        title={
          deleteSeriesNote?.kind === "template"
            ? `Delete "${title}" and stop the series?`
            : `Delete "${title}"?`
        }
        confirmLabel={deleteSeriesNote?.kind === "template" ? "Delete and stop series" : "Delete expense"}
        busyLabel="Deleting…"
        busy={busy}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={handleDelete}
      >
        <p style={{ margin: 0 }}>
          This takes it out of every balance it affects. You can undo it straight afterwards.
        </p>
        {deleteSeriesNote?.kind === "template" && (
          <div className="notice">{deleteSeriesNote.text}</div>
        )}
        {deleteSeriesNote?.kind === "occurrence" && (
          <p className="muted" style={{ margin: 0 }}>
            {deleteSeriesNote.text}
          </p>
        )}
      </ConfirmDialog>

      <StopSeriesDialog
        open={stop.confirming === "stop"}
        busy={stop.busy}
        error={stop.error}
        onClose={() => stop.setConfirming(null)}
        onConfirm={stop.confirmStop}
      />
      <ResumeSeriesDialog
        open={stop.confirming === "resume"}
        busy={stop.busy}
        error={stop.error}
        resumeOn={stop.resumeOn}
        onClose={() => stop.setConfirming(null)}
        onConfirm={stop.confirmResume}
      />
    </>
  );
}

/**
 * The mirror's own row, for its sync badge.
 *
 * Separate from `useExpense` because that returns the API-shaped detail every
 * screen reads, and `syncState` is not part of that shape: it is a fact about this
 * device, not about the expense.
 */
function useLocalExpenseRow(id: string | undefined) {
  return useLocal((db) => (id ? db.expenses.get(id) : Promise.resolve(undefined)), [id]);
}
