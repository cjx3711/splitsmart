/**
 * Turning a stored expense back into the form the user typed.
 *
 * This is the reason `expenses.split_type`, `expense_users.split_input` and
 * `expenses.split_meta` exist at all: the ledger numbers alone cannot say
 * whether "33.34 / 33.33 / 33.33" was an equal split, three exact amounts, or
 * a percentage. Re-deriving would guess, and the guess would show up as an
 * editor that disagrees with what the person entered.
 *
 * Shared by the logged-in edit dialog and the guest one, so the two cannot
 * drift on how a bill reopens.
 */
import { formatMoney, type ExpenseDetail } from "./api.ts";
import type { Payment } from "./PaidBy.tsx";
import type { SplitDraftInit } from "./SplitEditor.tsx";
import type { ExpenseFormInit } from "./ExpenseForm.tsx";

/** Recovers who paid what as one of PaidBy's three shapes, from the raw shares. */
export function reconstructPayment(
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
export function reconstructSplit(
  expense: ExpenseDetail,
  decimals: number | null,
): SplitDraftInit {
  const money = (minor: number) => formatMoney(minor, decimals ?? 2) ?? String(minor);

  if (expense.split_type === "itemized") {
    const meta = expense.split_meta
      ? (JSON.parse(expense.split_meta) as {
          items: Array<{ label: string | null; amountMinor: number; participantIds: string[] }>;
          taxMinor?: number;
          tipMinor?: number;
        })
      : { items: [] };

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

/** Everything ExpenseForm needs to reopen this expense exactly as entered. */
export function reconstructExpenseForm(
  expense: ExpenseDetail,
  decimals: number | null,
): ExpenseFormInit {
  return {
    description: expense.description,
    details: expense.details,
    amount: formatMoney(expense.cost_minor, decimals ?? 2) ?? "",
    date: expense.date.slice(0, 10),
    categoryId: expense.category_id ?? 18,
    payment: reconstructPayment(expense.shares, expense.cost_minor),
    split: reconstructSplit(expense, decimals),
    // A template reopens with its own schedule selected. An occurrence does not:
    // `repeat_of` is set on it and `repeat_interval` is null, so the control shows
    // "does not repeat", which is the truth about that individual bill.
    repeatInterval: expense.repeat_interval ?? null,
  };
}
