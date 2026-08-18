/**
 * Expense form in a modal. Shared by the logged-in app and the guest shell.
 *
 * ExpenseForm is deliberately ignorant of where its people come from; this is
 * just the surround. AddExpenseDialog / EditExpenseDialog load the candidate
 * pool from the mirror; the guest screens pass the people the link can see.
 * Either way the form, the split engine, and the dialog chrome are the same,
 * so a preview cannot disagree with a stored expense by a cent, and a guest
 * cannot get a different close/Escape behaviour from a logged-in user.
 */
import { Modal } from "./Modal.tsx";
import { ExpenseForm, type ExpenseFormInit } from "./ExpenseForm.tsx";
import { displayName, type ExpenseInput, type Group } from "./api.ts";
import type { Person } from "./PeoplePicker.tsx";

export function expensePeople(
  currentUserId: string,
  groupId: string | null,
  groupMembers: Array<{ id: string; name: string; nickname?: string | null }> | null | undefined,
  friends: Array<{ id: string; name: string; nickname?: string | null }>,
): Person[] {
  const you: Person = { id: currentUserId, label: "You" };
  if (groupId !== null) {
    if (!groupMembers) return [you];
    return groupMembers.map((m) => ({
      id: m.id,
      label: m.id === currentUserId ? "You" : displayName(m),
    }));
  }
  return [you, ...friends.map((f) => ({ id: f.id, label: displayName(f) }))];
}

export function ExpenseDialog({
  open,
  title,
  onClose,
  candidates,
  initialParticipantIds,
  currentUserId,
  defaultCurrency,
  groups,
  groupId,
  onGroupChange,
  initial,
  submitLabel,
  allowRepeat,
  onSubmit,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  candidates: Person[];
  initialParticipantIds: string[];
  currentUserId: string;
  defaultCurrency: string;
  groups?: Group[];
  groupId: string | null;
  onGroupChange?: (groupId: string | null) => void;
  initial?: ExpenseFormInit;
  submitLabel?: string;
  allowRepeat?: boolean;
  onSubmit: (input: ExpenseInput) => Promise<void>;
}) {
  return (
    <Modal open={open} title={title} onClose={onClose}>
      <ExpenseForm
        className="stack"
        candidates={candidates}
        initialParticipantIds={initialParticipantIds}
        currentUserId={currentUserId}
        defaultCurrency={defaultCurrency}
        groups={groups}
        groupId={groupId}
        onGroupChange={onGroupChange}
        initial={initial}
        submitLabel={submitLabel}
        allowRepeat={allowRepeat}
        onSubmit={async (input) => {
          await onSubmit(input);
          onClose();
        }}
      />
    </Modal>
  );
}
