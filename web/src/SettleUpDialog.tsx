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
 * Group settle-up always offers the suggested transfers as presets, plus a
 * path to type a different payment. Friend settle-up still skips the picker
 * when only one currency is outstanding.
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
      id: `${s.currencyCode}:${transfer.fromUserId}:${transfer.toUserId}:${i}`,
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
  preferredCurrency,
  choices,
  allowManual = false,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  people: Person[];
  currencies: string[];
  preferredCurrency?: string;
  choices: SettleChoice[];
  /** Group settle-up: always show the suggested transfers, plus a typed path. */
  allowManual?: boolean;
  onClose: () => void;
  onSubmit: (payment: SettlePayment) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (open) setPicked(null);
  }, [open]);

  const showPicker = allowManual
    ? picked === null && choices.length > 0
    : choices.length > 1 && picked === null;
  const active =
    picked && picked !== MANUAL_ID
      ? choices.find((c) => c.id === picked)
      : !allowManual && choices.length <= 1
        ? choices[0]
        : undefined;
  const canGoBack = picked !== null && (allowManual || choices.length > 1);
  const grouped = choicesByCurrency(choices);
  const showCurrencyHeadings = grouped.length > 1;

  return (
    <Modal open={open} title={title} onClose={onClose}>
      {showPicker ? (
        <div className="settle-currency-picker">
          <p className="muted" style={{ margin: 0 }}>
            {allowManual
              ? "Pick a suggested payment, or enter a different amount. A payment only clears that currency."
              : "Which balance do you want to settle? A payment only clears that currency."}
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
          {allowManual && (
            <button
              type="button"
              className="secondary settle-manual"
              onClick={() => setPicked(MANUAL_ID)}
            >
              Enter a different amount
            </button>
          )}
        </div>
      ) : (
        <div className="stack">
          {canGoBack && (
            <button type="button" className="link settle-back" onClick={() => setPicked(null)}>
              {allowManual ? "Choose a different payment" : "Choose a different currency"}
            </button>
          )}
          <SettleUpForm
            key={picked ?? active?.id ?? "form"}
            className="stack"
            people={people}
            currencies={currencies}
            preferredCurrency={preferredCurrency}
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
