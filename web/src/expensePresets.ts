import type { Payment } from "./PaidBy.tsx";
import type { SplitDraftInit } from "./SplitEditor.tsx";

export const EXPENSE_PRESETS = [
  { id: "i-owe", label: "I owe them" },
  { id: "they-owe", label: "They owe me" },
  { id: "i-paid", label: "I paid and split equally" },
  { id: "they-paid", label: "They paid and split equally" },
] as const;

export type ExpensePreset = (typeof EXPENSE_PRESETS)[number]["id"];

/** Weights keep the shortcut correct as the amount, currency or people change. */
export function expensePreset(
  preset: ExpensePreset,
  participantIds: string[],
  currentUserId: string,
  otherPayerId: string,
): { payment: Payment; split: Pick<SplitDraftInit, "mode" | "values"> } {
  const oneSided = preset === "i-owe" || preset === "they-owe";
  return {
    payment: {
      kind: "single",
      payerId: preset === "i-owe" || preset === "they-paid" ? otherPayerId : currentUserId,
    },
    split: {
      mode: oneSided ? "shares" : "equal",
      values: oneSided
        ? Object.fromEntries(participantIds.map((id) => [
            id,
            (preset === "i-owe" ? id === currentUserId : id !== currentUserId) ? "1" : "0",
          ]))
        : {},
    },
  };
}
