/**
 * Reopens an existing expense for editing.
 *
 * Mirrors AddExpenseDialog's job of deciding who can be on the expense (the
 * chosen group's members, or your friends), but seeds ExpenseForm from the
 * expense already on file instead of starting blank. The per-person
 * `split_input` and, for itemized splits, `split_meta` are exactly what lets
 * the split reopen as typed rather than being re-derived from the stored
 * amounts. See src/domain/expenses.ts.
 *
 * The save is queued, not posted, and carries `baseVersion` - the version this
 * form was opened against. A mismatch on the server is a CONFLICT rather than an
 * overwrite: somebody else edited the same bill while this one was waiting, and
 * only a person can say which number is right. See web/src/pages/Conflicts.tsx.
 */
import { useEffect, useMemo, useState } from "react";
import { type ExpenseDetail } from "./api.ts";
import { ExpenseDialog, expensePeople } from "./ExpenseDialog.tsx";
import type { ExpenseFormInit } from "./ExpenseForm.tsx";
import { useAuth } from "./App.tsx";
import { useGroups, useGroupView, useRelatedPeople } from "./localData.ts";
import { useSync } from "./sync/SyncProvider.tsx";
import { useOnline } from "./OnlineOnly.tsx";
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
  const { engine } = useSync();
  const online = useOnline();
  const { decimalsFor } = useCurrencies();

  const [groupId, setGroupId] = useState<string | null>(expense.group_id);

  const friends = useRelatedPeople()?.people ?? [];
  const groups = useGroups()?.groups ?? [];
  const groupView = useGroupView(groupId ?? undefined);

  useEffect(() => {
    if (open) setGroupId(expense.group_id);
  }, [open, expense.group_id]);

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

  return (
    <ExpenseDialog
      open={open}
      title="Edit expense"
      onClose={onClose}
      candidates={expensePeople(user.id, groupId, groupView?.members, friends)}
      initialParticipantIds={initialParticipantIds}
      currentUserId={user.id}
      defaultCurrency={expense.currency_code}
      groups={groups}
      groupId={groupId}
      onGroupChange={setGroupId}
      submitLabel="Save changes"
      initial={initial}
      allowRepeat={online}
      onSubmit={async (input) => {
        if (!engine) throw new Error("Not ready to save yet.");
        await engine.enqueue({
          kind: "expense.update",
          id: expense.id,
          baseVersion: expense.version ?? 1,
          payload: { ...input, groupId },
        });
        await onSaved();
      }}
    />
  );
}
