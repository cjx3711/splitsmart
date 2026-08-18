/**
 * One expense, seen through a guest link. Editable and deletable, like the
 * logged-in screen: a guest is a participant in the ledger, not a spectator.
 *
 * The edit dialog is seeded exactly as EditExpenseDialog seeds it, from
 * split_type / split_input / split_meta, so the split reopens as it was typed
 * rather than being re-derived from the stored amounts.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { ExpenseDetail as ExpenseDetailData } from "../api.ts";
import { Amount, useCurrencies } from "../money.tsx";
import { makeLookup } from "../ExpenseList.tsx";
import { reconstructExpenseForm } from "../reopenExpense.ts";
import { CommentThread } from "../CommentThread.tsx";
import { RepeatNote, seriesDeleteNote } from "../RepeatNote.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { ExpenseDialog } from "../ExpenseDialog.tsx";
import { expenseCrumbs } from "./guestCrumbs.ts";
import { useGuest } from "./GuestApp.tsx";
import { guestApi, guestFullName, type GuestVisiblePerson } from "./guestApi.ts";
import { avatarFromRow } from "../Avatar.tsx";
import { FriendListItem } from "../FriendListItem.tsx";

export function GuestExpense() {
  const { id } = useParams<{ id: string }>();
  const { session } = useGuest();
  const me = session.actingAs!;
  const navigate = useNavigate();
  const { decimalsFor } = useCurrencies();

  const [expense, setExpense] = useState<ExpenseDetailData | null>(null);
  const [people, setPeople] = useState<GuestVisiblePerson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [detail, everyone] = await Promise.all([guestApi.expense(id), guestApi.people()]);
      setExpense(detail.expense);
      setPeople(everyone.people);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this expense");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const initial = useMemo(
    () => (expense ? reconstructExpenseForm(expense, decimalsFor(expense.currency_code)) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only when the expense (re)loads
    [expense],
  );

  function back() {
    if (expense?.group_id) navigate(`/groups/${expense.group_id}`);
    else navigate("/friend");
  }

  async function handleDelete() {
    if (!id) return;
    setDeleting(true);
    try {
      await guestApi.deleteExpense(id);
      back();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this expense");
      setDeleting(false);
      setConfirmingDelete(false);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!expense || !initial) return <p className="muted">Loading…</p>;

  const nameOf = makeLookup(people, me.id);
  const avatarFor = (userId: string) => {
    const person = people.find((p) => p.id === userId);
    return person ? avatarFromRow(person) : { id: userId, name: nameOf(userId) };
  };
  const title = expense.is_payment === 1 ? "Settle up" : expense.description;
  const deleteSeriesNote = seriesDeleteNote(expense);

  // Only the people already on the bill, plus anyone in the same group. The
  // server decides for real; this just stops the picker offering a refusal.
  const candidates = people.map((p) => ({
    id: p.id,
    label: p.id === me.id ? "You" : guestFullName(p),
  }));

  return (
    <>
      {/* The group is in the trail, so the meta line below no longer repeats it. */}
      <Breadcrumbs
        trail={expenseCrumbs(session, {
          groupId: expense.group_id,
          groupName: expense.group_name,
          title,
        })}
      />

      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {expense.date.slice(0, 10)}
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
        <RepeatNote
          repeatInterval={expense.repeat_interval}
          nextRepeat={expense.next_repeat}
          repeatOf={expense.repeat_of}
          repeatPaused={expense.repeat_paused}
          seriesHref={`/expenses/${expense.id}/series`}
        />
      </div>

      <h2>Who paid, who owes</h2>
      <div className="list">
        {expense.shares.map((share) => (
          <FriendListItem
            key={share.user_id}
            avatar={avatarFor(share.user_id)}
            title={nameOf(share.user_id)}
          >
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
          </FriendListItem>
        ))}
      </div>

      <CommentThread
        expenseId={expense.id}
        currentUserId={me.id}
        api={{
          list: guestApi.comments,
          add: guestApi.addComment,
          remove: guestApi.deleteComment,
        }}
      />

      <ExpenseDialog
        open={editing}
        title="Edit expense"
        onClose={() => setEditing(false)}
        candidates={candidates}
        initialParticipantIds={expense.shares.map((s) => s.user_id)}
        currentUserId={me.id}
        defaultCurrency={expense.currency_code}
        groupId={expense.group_id}
        initial={initial}
        submitLabel="Save changes"
        onSubmit={async (input) => {
          await guestApi.updateExpense(expense.id, { ...input, groupId: expense.group_id });
          await load();
        }}
      />

      <ConfirmDialog
        open={confirmingDelete}
        title={
          deleteSeriesNote?.kind === "template"
            ? `Delete "${title}" and stop the series?`
            : `Delete "${title}"?`
        }
        confirmLabel={
          deleteSeriesNote?.kind === "template" ? "Delete and stop series" : "Delete expense"
        }
        busyLabel="Deleting…"
        busy={deleting}
        onClose={() => setConfirmingDelete(false)}
        onConfirm={handleDelete}
      >
        <p style={{ margin: 0 }}>
          This removes it from every balance it affects. This can't be undone.
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
    </>
  );
}
