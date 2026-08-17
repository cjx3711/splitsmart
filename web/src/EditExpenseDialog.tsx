/**
 * Reopens an existing expense for editing.
 *
 * Mirrors AddExpenseDialog's job of deciding who can be on the expense (the
 * chosen group's members, or your friends), but seeds ExpenseForm from the
 * expense already on file instead of starting blank. The per-person
 * `split_input` and, for itemized splits, `split_meta` are exactly what lets
 * the split reopen as typed rather than being re-derived from the stored
 * amounts. See src/domain/expenses.ts.
 */
import { useEffect, useMemo, useState } from "react";
import { api, fullName, type ExpenseDetail, type Friend, type Group } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { ExpenseForm, type ExpenseFormInit } from "./ExpenseForm.tsx";
import type { Person } from "./PeoplePicker.tsx";
import { useAuth, useSidebarRefresh } from "./App.tsx";
import { useCurrencies } from "./money.tsx";
import { reconstructExpenseForm } from "./reopenExpense.ts";

export function EditExpenseDialog({
  expense,
  open,
  onClose,
  onSaved,
}: {
  expense: ExpenseDetail;
  open: boolean;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const { user } = useAuth();
  const refreshSidebar = useSidebarRefresh();
  const { decimalsFor } = useCurrencies();

  const [friends, setFriends] = useState<Friend[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState<string | null>(expense.group_id);
  const [members, setMembers] = useState<Person[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setGroupId(expense.group_id);
    void api.listFriends().then((r) => setFriends(r.friends)).catch(() => setFriends([]));
    void api.listGroups().then((r) => setGroups(r.groups)).catch(() => setGroups([]));
  }, [open, expense.group_id]);

  useEffect(() => {
    if (!open || groupId === null || !user) {
      setMembers(null);
      return;
    }
    let live = true;
    void api
      .getGroup(groupId)
      .then((r) => {
        if (!live) return;
        setMembers(
          r.members.map((m) => ({ id: m.id, label: m.id === user.id ? "You" : fullName(m) })),
        );
      })
      .catch(() => live && setMembers([]));
    return () => {
      live = false;
    };
  }, [open, groupId, user]);

  const initialParticipantIds = useMemo(
    () => expense.shares.map((s) => s.user_id).sort(),
    [expense],
  );

  const initial = useMemo<ExpenseFormInit>(
    () => reconstructExpenseForm(expense, decimalsFor(expense.currency_code)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only when the expense itself (re)loads
    [expense],
  );

  if (!user) return null;

  const you: Person = { id: user.id, label: "You" };
  const candidates: Person[] =
    groupId !== null
      ? (members ?? [you])
      : [you, ...friends.map((f) => ({ id: f.id, label: fullName(f) }))];

  return (
    <Modal open={open} title="Edit expense" onClose={onClose}>
      <ExpenseForm
        className="stack"
        candidates={candidates}
        initialParticipantIds={initialParticipantIds}
        currentUserId={user.id}
        defaultCurrency={expense.currency_code}
        groups={groups}
        groupId={groupId}
        onGroupChange={setGroupId}
        submitLabel="Save changes"
        initial={initial}
        onSubmit={async (input) => {
          await api.updateExpense(expense.id, { ...input, groupId });
          onClose();
          refreshSidebar();
          await onSaved();
        }}
      />
    </Modal>
  );
}
