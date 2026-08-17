/**
 * Who actually put the money in.
 *
 * This is a separate axis from how the cost is divided, and conflating the two
 * is the mistake worth avoiding: `expense_users` has always had `paid_share`
 * per person, and the split engine has always accepted several payers; it was
 * only the form that insisted on exactly one. So this control edits payments
 * and nothing else; SplitEditor still owns who owes what.
 *
 * Three shapes, which between them cover what Splitwise offers:
 *
 *   single      one person fronted the lot (the overwhelmingly common case)
 *   amounts     several people each put in a stated amount
 *   own-share   everyone paid exactly what they owe, so nobody owes anybody
 *
 * Amounts are held as RAW TEXT, not minor units, for the same reason the rest
 * of the form does: "12." is a legitimate thing to have typed halfway through,
 * and parsing happens against the selected currency at the edge (buildSplit).
 */
import { useState } from "react";
import { Modal } from "./Modal.tsx";
import { Amount, useCurrencies } from "./money.tsx";
import type { Person } from "./PeoplePicker.tsx";

export type Payment =
  | { kind: "single"; payerId: string }
  | { kind: "amounts"; amounts: Record<string, string> }
  | { kind: "own-share" };

/**
 * What each person put in, in minor units, or the reason it cannot be worked
 * out yet. `own-share` resolves to null on purpose: what each person owes is
 * not known until the split has been computed, so buildSplit fills it in.
 */
export function resolvePayments(
  payment: Payment,
  participantIds: string[],
  costMinor: number,
  currency: string,
  parseInCurrency: (input: string, currency: string) => number,
): Map<string, number> | null {
  if (payment.kind === "own-share") return null;

  const paid = new Map<string, number>(participantIds.map((id) => [id, 0]));

  if (payment.kind === "single") {
    paid.set(payment.payerId, costMinor);
    return paid;
  }

  for (const id of participantIds) {
    const raw = (payment.amounts[id] ?? "").trim();
    paid.set(id, raw === "" ? 0 : parseInCurrency(raw, currency));
  }
  return paid;
}

/** The one-line summary shown on the button that opens the dialog. */
function summarise(payment: Payment, people: Person[]): string {
  if (payment.kind === "own-share") return "Each their own share";

  if (payment.kind === "single") {
    return people.find((p) => p.id === payment.payerId)?.label ?? "Someone else";
  }

  const payers = people.filter((p) => {
    const raw = (payment.amounts[p.id] ?? "").trim();
    return raw !== "" && Number(raw) !== 0;
  });
  if (payers.length === 0) return "Nobody yet";
  if (payers.length === 1) return payers[0]!.label;
  return `${payers.length} people`;
}

export function PaidByField({
  people,
  payment,
  onChange,
  costMinor,
  currency,
  parseInCurrency,
}: {
  /** The expense's participants, in display order. */
  people: Person[];
  payment: Payment;
  onChange: (payment: Payment) => void;
  costMinor: number;
  currency: string;
  parseInCurrency: (input: string, currency: string) => number;
}) {
  const { decimalsFor } = useCurrencies();
  const [open, setOpen] = useState(false);
  const decimals = decimalsFor(currency);

  // Unparseable rows count as zero here; the preview under the split editor
  // reports them properly rather than this line turning into an error box.
  const entered = people.reduce((sum, person) => {
    if (payment.kind !== "amounts") return sum;
    const raw = (payment.amounts[person.id] ?? "").trim();
    if (raw === "") return sum;
    try {
      return sum + parseInCurrency(raw, currency);
    } catch {
      return sum;
    }
  }, 0);
  const remaining = costMinor - entered;

  function setAmount(id: string, value: string) {
    const amounts = payment.kind === "amounts" ? { ...payment.amounts } : {};
    amounts[id] = value;
    onChange({ kind: "amounts", amounts });
  }

  return (
    <>
      <label htmlFor="paid-by">Paid by</label>
      <button
        type="button"
        id="paid-by"
        className="field-button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        {summarise(payment, people)}
        <span aria-hidden="true" className="field-button-caret">
          ▾
        </span>
      </button>

      <Modal open={open} title="Who paid?" onClose={() => setOpen(false)}>
        <div className="stack">
          <div className="stack-tight">
            {people.map((person) => (
              <button
                key={person.id}
                type="button"
                className={`payer-option${
                  payment.kind === "single" && payment.payerId === person.id ? " is-active" : ""
                }`}
                aria-pressed={payment.kind === "single" && payment.payerId === person.id}
                onClick={() => {
                  onChange({ kind: "single", payerId: person.id });
                  setOpen(false);
                }}
              >
                {person.label} paid the whole amount
              </button>
            ))}
          </div>

          <div className="split-editor stack">
            <button
              type="button"
              className={`payer-option${payment.kind === "own-share" ? " is-active" : ""}`}
              aria-pressed={payment.kind === "own-share"}
              onClick={() => {
                onChange({ kind: "own-share" });
                setOpen(false);
              }}
            >
              Each person paid for their own share
            </button>
            <p className="split-hint" style={{ marginTop: 0 }}>
              Records what everyone spent without anybody ending up owing anybody. Useful for a
              night where you all paid your own way but still want it on the ledger.
            </p>

            <div>
              <label>Or several people put in different amounts</label>
              <div className="split-rows">
                {people.map((person) => (
                  <div key={person.id} className="split-row">
                    <span className="split-row-name">{person.label}</span>
                    <span className="split-row-input">
                      <input
                        value={payment.kind === "amounts" ? (payment.amounts[person.id] ?? "") : ""}
                        onChange={(e) => setAmount(person.id, e.target.value)}
                        placeholder={decimals === 0 ? "0" : `0.${"0".repeat(decimals ?? 2)}`}
                        inputMode="decimal"
                        aria-label={`${person.label} paid`}
                      />
                    </span>
                  </div>
                ))}
              </div>

              {payment.kind === "amounts" && costMinor > 0 && (
                <p className={remaining === 0 ? "split-hint" : "split-problem"}>
                  {remaining === 0 ? (
                    <>That accounts for the whole amount.</>
                  ) : remaining > 0 ? (
                    <>
                      <Amount minor={remaining} currency={currency} /> still unaccounted for.
                    </>
                  ) : (
                    <>
                      <Amount minor={-remaining} currency={currency} /> more than the expense total.
                    </>
                  )}
                </p>
              )}
            </div>
          </div>

          <div>
            <button type="button" className="inline" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
