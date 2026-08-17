/**
 * Add or edit an expense, as a guest.
 *
 * Wraps the SAME ExpenseForm the logged-in app uses, and for the same reason
 * the split engine is shared with the browser: a second implementation would
 * drift, and the first symptom of drift is a preview that disagrees with the
 * stored expense by a cent.
 *
 * What differs from AddExpenseDialog is only where the people come from and
 * where the group can be. A guest never picks a group from a dropdown: a group
 * link has exactly one, and a friend link's expenses are between the two of
 * you. Offering a choice the server will refuse is worse than offering none.
 */
import { Modal } from "../Modal.tsx";
import { ExpenseForm } from "../ExpenseForm.tsx";
import type { Person } from "../PeoplePicker.tsx";
import type { ExpenseInput } from "../api.ts";
import type { ExpenseFormInit } from "../ExpenseForm.tsx";

export function GuestExpenseDialog({
  open,
  onClose,
  title,
  candidates,
  initialParticipantIds,
  currentUserId,
  defaultCurrency,
  groupId,
  initial,
  submitLabel,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  candidates: Person[];
  initialParticipantIds: string[];
  currentUserId: string;
  defaultCurrency: string;
  /** Fixed by the link. Null for the 1:1 surface of a friend link. */
  groupId: string | null;
  initial?: ExpenseFormInit;
  submitLabel?: string;
  onSubmit: (input: ExpenseInput & { groupId: string | null }) => Promise<void>;
}) {
  return (
    <Modal open={open} title={title} onClose={onClose}>
      <ExpenseForm
        className="stack"
        candidates={candidates}
        initialParticipantIds={initialParticipantIds}
        currentUserId={currentUserId}
        defaultCurrency={defaultCurrency}
        // No `groups` and no `onGroupChange`: the group is not the guest's to
        // change, so the form does not render the picker at all.
        groupId={groupId}
        initial={initial}
        submitLabel={submitLabel}
        onSubmit={async (input) => {
          await onSubmit({ ...input, groupId });
          onClose();
        }}
      />
    </Modal>
  );
}
