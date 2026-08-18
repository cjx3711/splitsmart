/**
 * Settle-up in a modal. Shared by the group and friend screens, logged-in and
 * guest: a payment only clears one currency, so when several are outstanding
 * we pick that currency first rather than opening on the alphabetical one.
 *
 * The form itself is SettleUpForm; this is the surround and the picker. What
 * differs between call sites is only how the choices are labelled (a suggested
 * transfer in a group, "X owes you" between two people) and where the write
 * goes (outbox vs guest API).
 */
import { useEffect, useState, type ReactNode } from "react";
import { Modal } from "./Modal.tsx";
import { Amount } from "./money.tsx";
import { SettleUpForm, type SettlePayment } from "./SettleUpForm.tsx";
import type { CurrencyAmount } from "./api.ts";
import type { Person } from "./PeoplePicker.tsx";

export type SettleChoice = {
  currencyCode: string;
  label: ReactNode;
  initial: {
    fromUserId: string;
    toUserId: string;
    amount: string;
    currencyCode: string;
  };
};

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
  outstandingCurrencies: string[],
  settle: Array<{
    currencyCode: string;
    transfers: Array<{ fromUserId: string; toUserId: string; amountMinor: number }>;
  }>,
  nameOf: (id: string) => string,
  people: Person[],
  formatMoney: (minor: number, currency: string) => string | null,
): SettleChoice[] {
  return outstandingCurrencies.map((code) => {
    const transfer = settle.find((s) => s.currencyCode === code)?.transfers[0];
    return {
      currencyCode: code,
      label: transfer ? (
        <>
          {nameOf(transfer.fromUserId)} → {nameOf(transfer.toUserId)}{" "}
          <Amount minor={transfer.amountMinor} currency={code} />
        </>
      ) : (
        code
      ),
      initial: transfer
        ? {
            fromUserId: transfer.fromUserId,
            toUserId: transfer.toUserId,
            amount: formatMoney(transfer.amountMinor, code) ?? "",
            currencyCode: code,
          }
        : {
            fromUserId: people[0]?.id ?? "",
            toUserId: people[1]?.id ?? "",
            amount: "",
            currencyCode: code,
          },
    };
  });
}

/**
 * The expense body a payment is: the payer fronts the lot, the recipient
 * owes it all. Logged-in screens enqueue this; guests post a slimmer body.
 */
export function paymentAsExpense(payment: SettlePayment, groupId: string | null) {
  return {
    groupId,
    description: "Payment",
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

export function SettleUpDialog({
  open,
  title,
  people,
  currencies,
  preferredCurrency,
  choices,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  people: Person[];
  currencies: string[];
  preferredCurrency?: string;
  choices: SettleChoice[];
  onClose: () => void;
  onSubmit: (payment: SettlePayment) => Promise<void>;
}) {
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (open) setPicked(null);
  }, [open]);

  const showPicker = choices.length > 1 && picked === null;
  const active = picked
    ? choices.find((c) => c.currencyCode === picked)
    : choices.length <= 1
      ? choices[0]
      : undefined;

  return (
    <Modal open={open} title={title} onClose={onClose}>
      {showPicker ? (
        <div className="settle-currency-picker">
          <p className="muted" style={{ margin: 0 }}>
            Which balance do you want to settle? A payment only clears that currency.
          </p>
          {choices.map((choice) => (
            <button
              key={choice.currencyCode}
              type="button"
              className="secondary"
              onClick={() => setPicked(choice.currencyCode)}
            >
              {choice.label}
            </button>
          ))}
        </div>
      ) : (
        <SettleUpForm
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
      )}
    </Modal>
  );
}
