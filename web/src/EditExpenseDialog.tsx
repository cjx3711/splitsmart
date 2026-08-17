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
import { api, fullName, formatMoney, type ExpenseDetail, type Friend, type Group } from "./api.ts";
import type { Payment } from "./PaidBy.tsx";
import type { SplitDraftInit } from "./SplitEditor.tsx";
import { Modal } from "./Modal.tsx";
import { ExpenseForm, type ExpenseFormInit } from "./ExpenseForm.tsx";
import type { Person } from "./PeoplePicker.tsx";
import { useAuth, useSidebarRefresh } from "./App.tsx";
import { useCurrencies } from "./money.tsx";

/** Recovers who paid what as one of PaidBy's three shapes, from the raw shares. */
function reconstructPayment(
  shares: ExpenseDetail["shares"],
  costMinor: number,
): Payment {
  const payers = shares.filter((s) => s.paid_share_minor > 0);

  if (payers.length === 1 && payers[0]!.paid_share_minor === costMinor) {
    return { kind: "single", payerId: payers[0]!.user_id };
  }

  if (shares.length > 1 && shares.every((s) => s.paid_share_minor === s.owed_share_minor)) {
    return { kind: "own-share" };
  }

  return {
    kind: "amounts",
    amounts: Object.fromEntries(shares.map((s) => [s.user_id, String(s.paid_share_minor)])),
  };
}

/** Recovers the split draft from split_type / split_input / split_meta. */
function reconstructSplit(
  expense: ExpenseDetail,
  decimals: number | null,
): SplitDraftInit {
  const money = (minor: number) => formatMoney(minor, decimals ?? 2) ?? String(minor);

  if (expense.split_type === "itemized") {
    const meta = expense.split_meta ? (JSON.parse(expense.split_meta) as {
      items: Array<{ label: string | null; amountMinor: number; participantIds: number[] }>;
      taxMinor?: number;
      tipMinor?: number;
    }) : { items: [] };

    return {
      mode: "itemized",
      values: {},
      items: meta.items.map((item) => ({
        label: item.label ?? "",
        amount: money(item.amountMinor),
        participantIds: item.participantIds,
      })),
      tax: meta.taxMinor ? money(meta.taxMinor) : "",
      tip: meta.tipMinor ? money(meta.tipMinor) : "",
    };
  }

  const isMoney = expense.split_type === "exact" || expense.split_type === "adjustment";
  const values = Object.fromEntries(
    expense.shares
      .filter((s) => s.split_input !== null)
      .map((s) => [s.user_id, isMoney ? money(s.split_input!) : String(s.split_input)]),
  );

  return { mode: expense.split_type, values };
}

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
  const [groupId, setGroupId] = useState<number | null>(expense.group_id);
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
    () => expense.shares.map((s) => s.user_id).sort((a, b) => a - b),
    [expense],
  );

  const initial = useMemo<ExpenseFormInit>(() => {
    const decimals = decimalsFor(expense.currency_code);
    return {
      description: expense.description,
      details: expense.details,
      amount: formatMoney(expense.cost_minor, decimals ?? 2) ?? "",
      date: expense.date.slice(0, 10),
      categoryId: expense.category_id ?? 18,
      payment: reconstructPayment(expense.shares, expense.cost_minor),
      split: reconstructSplit(expense, decimals),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-seed only when the expense itself (re)loads
  }, [expense]);

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
