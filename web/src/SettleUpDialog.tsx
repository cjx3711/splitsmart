/**
 * Settle-up in a modal. Shared by the group and friend screens, logged-in and
 * guest: a payment only clears one currency, so when several are outstanding
 * we pick that currency first rather than opening on the alphabetical one.
 *
 * The form itself is SettleUpForm; this is the surround and the picker. What
 * differs between call sites is only how the choices are labelled (a suggested
 * transfer in a group, "X owes you" between two people) and where the write
 * goes (outbox vs guest API).
 *
 * Group settle-up always offers the suggested transfers as presets. Friend
 * settle-up still skips the picker when only one currency is outstanding.
 * Whenever the picker IS shown, so is a path to type a different payment: the
 * offered balances are shortcuts, and a picker with no way past it cannot
 * record a part payment or a currency nobody happens to be owed in.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "./Modal.tsx";
import { Amount } from "./money.tsx";
import { SettleUpForm, type SettlePayment } from "./SettleUpForm.tsx";
import type { CurrencyAmount } from "./api.ts";
import type { Person } from "./PeoplePicker.tsx";

export type SettleChoice = {
  id: string;
  currencyCode: string;
  label: ReactNode;
  initial: {
    fromUserId: string;
    toUserId: string;
    amount: string;
    currencyCode: string;
  };
};

const MANUAL_ID = "__manual__";

export function friendSettleChoices(
  balances: CurrencyAmount[],
  youId: string,
  themId: string,
  themName: string,
  formatMoney: (minor: number, currency: string) => string | null,
): SettleChoice[] {
  return [...balances]
    .sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor))
    .map((b) => ({
      id: b.currencyCode,
      currencyCode: b.currencyCode,
      label: (
        <>
          {b.amountMinor > 0 ? `${themName} owes you ` : `You owe ${themName} `}
          <Amount minor={b.amountMinor} currency={b.currencyCode} absolute />
        </>
      ),
      initial: {
        fromUserId: b.amountMinor > 0 ? themId : youId,
        toUserId: b.amountMinor > 0 ? youId : themId,
        amount: formatMoney(Math.abs(b.amountMinor), b.currencyCode) ?? "",
        currencyCode: b.currencyCode,
      },
    }));
}

/**
 * The id of one suggested transfer.
 *
 * Exported because `SettleSuggestion` renders the same list on the group page
 * and opens this dialog straight onto a row; both sides have to name a choice
 * the same way or the prefill silently falls back to the picker.
 */
export function settleChoiceId(
  currencyCode: string,
  transfer: { fromUserId: string; toUserId: string },
  index: number,
): string {
  return `${currencyCode}:${transfer.fromUserId}:${transfer.toUserId}:${index}`;
}

export function groupSettleChoices(
  settle: Array<{
    currencyCode: string;
    transfers: Array<{ fromUserId: string; toUserId: string; amountMinor: number }>;
  }>,
  nameOf: (id: string) => string,
  formatMoney: (minor: number, currency: string) => string | null,
): SettleChoice[] {
  return settle.flatMap((s) =>
    s.transfers.map((transfer, i) => ({
      id: settleChoiceId(s.currencyCode, transfer, i),
      currencyCode: s.currencyCode,
      label: (
        <>
          {nameOf(transfer.fromUserId)} → {nameOf(transfer.toUserId)}{" "}
          <Amount minor={transfer.amountMinor} currency={s.currencyCode} />
        </>
      ),
      initial: {
        fromUserId: transfer.fromUserId,
        toUserId: transfer.toUserId,
        amount: formatMoney(transfer.amountMinor, s.currencyCode) ?? "",
        currencyCode: s.currencyCode,
      },
    })),
  );
}

/**
 * The expense body a payment is: the payer fronts the lot, the recipient
 * owes it all. Logged-in screens enqueue this; guests post a slimmer body.
 */
export function paymentAsExpense(
  payment: {
    fromUserId: string;
    toUserId: string;
    amountMinor: number;
    currencyCode: string;
    date?: string;
    description?: string;
    details?: string;
  },
  groupId: string | null,
) {
  return {
    groupId,
    description: payment.description ?? "Payment",
    details: payment.details,
    costMinor: payment.amountMinor,
    currencyCode: payment.currencyCode,
    date: payment.date ?? new Date().toISOString(),
    splitType: "exact" as const,
    isPayment: true,
    participants: [
      { userId: payment.fromUserId, paidMinor: payment.amountMinor, input: 0 },
      { userId: payment.toUserId, paidMinor: 0, input: payment.amountMinor },
    ],
  };
}

function choicesByCurrency(choices: SettleChoice[]): Array<{ currencyCode: string; items: SettleChoice[] }> {
  const order: string[] = [];
  const byCode = new Map<string, SettleChoice[]>();
  for (const choice of choices) {
    const list = byCode.get(choice.currencyCode);
    if (list) list.push(choice);
    else {
      order.push(choice.currencyCode);
      byCode.set(choice.currencyCode, [choice]);
    }
  }
  return order.map((currencyCode) => ({ currencyCode, items: byCode.get(currencyCode)! }));
}

export function SettleUpDialog({
  open,
  title,
  people,
  currencies,
  choices,
  initialChoiceId,
  allowManual = false,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  people: Person[];
  currencies: string[];
  choices: SettleChoice[];
  /**
   * Open straight onto this choice, skipping the picker: the group page opens
   * the dialog by clicking a suggested transfer. "Choose a different payment"
   * still goes back to the full list.
   */
  initialChoiceId?: string;
  /** Group settle-up: always show the suggested transfers, plus a typed path. */
  allowManual?: boolean;
  onClose: () => void;
  onSubmit: (payment: SettlePayment) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string | null>(null);

  // `choices` is rebuilt on every render, so it cannot be a dependency here
  // without resetting the pick the user just made. A stale id is handled below
  // instead, where the list is actually consulted.
  useEffect(() => {
    if (open) setPicked(initialChoiceId ?? null);
  }, [open, initialChoiceId]);

  // An id that is no longer offered - a sync landed, someone else recorded the
  // payment - drops back to the picker rather than prefilling an amount nobody
  // owes any more.
  const pickedChoice =
    picked !== null && picked !== MANUAL_ID ? choices.find((c) => c.id === picked) : undefined;
  const selected = picked !== null && picked !== MANUAL_ID && !pickedChoice ? null : picked;

  const showPicker = allowManual
    ? selected === null && choices.length > 0
    : choices.length > 1 && selected === null;
  const active =
    selected && selected !== MANUAL_ID
      ? pickedChoice
      : !allowManual && choices.length <= 1
        ? choices[0]
        : undefined;
  const canGoBack = selected !== null && (allowManual || choices.length > 1);
  const grouped = choicesByCurrency(choices);
  const showCurrencyHeadings = grouped.length > 1;

  return (
    <Modal open={open} title={title} onClose={onClose}>
      {showPicker ? (
        <div className="settle-currency-picker">
          <p className="muted" style={{ margin: 0 }}>
            {allowManual
              ? "Pick a suggested payment, or enter a different amount. A payment only clears that currency."
              : "Pick a balance to settle, or enter a different amount. A payment only clears that currency."}
          </p>
          {allowManual
            ? grouped.map((group) => (
                <div key={group.currencyCode} className="settle-choice-group">
                  {showCurrencyHeadings && <span className="eyebrow">{group.currencyCode}</span>}
                  {group.items.map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      className="secondary"
                      onClick={() => setPicked(choice.id)}
                    >
                      {choice.label}
                    </button>
                  ))}
                </div>
              ))
            : choices.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className="secondary"
                  onClick={() => setPicked(choice.id)}
                >
                  {choice.label}
                </button>
              ))}
          {/* Always offered. The listed balances are shortcuts, not the only
              thing anyone may record: a part payment, or a currency nobody is
              currently owed in, has to be typeable or the picker becomes a
              dead end. */}
          <button
            type="button"
            className="secondary settle-manual"
            onClick={() => setPicked(MANUAL_ID)}
          >
            Enter a different amount
          </button>
        </div>
      ) : (
        <div className="stack">
          {canGoBack && (
            <button type="button" className="link settle-back" onClick={() => setPicked(null)}>
              {allowManual ? "Choose a different payment" : "Choose a different balance"}
            </button>
          )}
          <SettleUpForm
            key={selected ?? active?.id ?? "form"}
            className="stack"
            people={people}
            currencies={currencies}
            initial={active?.initial}
            onSubmit={async (payment) => {
              await onSubmit(payment);
              onClose();
            }}
          />
        </div>
      )}
    </Modal>
  );
}
