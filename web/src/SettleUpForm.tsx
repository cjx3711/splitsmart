/**
 * Recording a payment, shared by the group and friend screens.
 *
 * A payment is an ordinary expense with is_payment = 1 (see
 * src/domain/expenses.ts), so it nets off through exactly the same balance
 * query as everything else. Nothing here is special-cased.
 *
 * A payment only clears the currency it is made in. Owing yen and paying in
 * dollars leaves both ledgers open; that follows from currencies never being
 * converted, and the form says so rather than letting people discover it.
 *
 * Two people is the common case and gets its own control: a direction ROW,
 * "A → B", that swaps when you click it, instead of two selects that can be
 * set to the same person. With three or more (a group) the selects stay, since
 * there is a real choice of who and not just of which way round.
 *
 * The note is optional and is NOT part of the expense: it is posted as an
 * ordinary comment on the payment by whoever submits this form. Payments carry
 * no description worth reading ("Payment"), so "for last week's taxi" has
 * nowhere else to live, and a comment is the one place that already renders on
 * the bill and syncs like everything else.
 */
import { useState, type FormEvent } from "react";
import { useCurrencies, useParseMoney } from "./money.tsx";
import { CurrencySelect } from "./CurrencySelect.tsx";
import { type Payer } from "./ExpenseForm.tsx";
import { HelpTip } from "./HelpTip.tsx";
import { SwapIcon } from "./Icons.tsx";

export interface SettlePayment {
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
  currencyCode: string;
  date: string;
  description?: string;
  details?: string;
  /** Free text the caller posts as a comment on the payment. Empty means none. */
  note?: string;
}

export function SettleUpForm({
  people,
  currencies,
  initial,
  onSubmit,
  className = "card stack",
}: {
  people: Payer[];
  /** Currencies actually in play between these people, most useful first. */
  currencies: string[];
  /** Prefill, e.g. from the group's suggested settle-up. */
  initial?: { fromUserId: string; toUserId: string; amount: string; currencyCode: string };
  onSubmit: (payment: SettlePayment) => Promise<void>;
  className?: string;
}) {
  const parseInCurrency = useParseMoney();
  const { decimalsFor } = useCurrencies();

  const [fromUserId, setFromUserId] = useState(initial?.fromUserId ?? people[0]?.id ?? "");
  const [toUserId, setToUserId] = useState(
    initial?.toUserId ?? people.find((p) => p.id !== (initial?.fromUserId ?? people[0]?.id))?.id ?? "",
  );
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [currency, setCurrency] = useState(initial?.currencyCode ?? currencies[0] ?? "USD");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pair = people.length === 2;

  function swap() {
    setFromUserId(toUserId);
    setToUserId(fromUserId);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    if (fromUserId === toUserId) {
      return setError("A payment needs two different people.");
    }

    let amountMinor: number;
    try {
      amountMinor = parseInCurrency(amount, currency);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid amount");
      return;
    }
    if (amountMinor <= 0) return setError("Amount must be greater than zero");

    setBusy(true);
    try {
      await onSubmit({
        fromUserId,
        toUserId,
        amountMinor,
        currencyCode: currency,
        date,
        note: note.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the payment");
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (id: string) => people.find((p) => p.id === id)?.label ?? "someone";

  return (
    <form onSubmit={handleSubmit} className={className}>
      {error && <p className="error">{error}</p>}

      {pair ? (
        <div>
          <span className="label-text">Who paid</span>
          <button
            type="button"
            className="settle-direction"
            onClick={swap}
            aria-label={`${nameOf(fromUserId)} paid ${nameOf(toUserId)}. Swap.`}
          >
            <span className="settle-direction-name">{nameOf(fromUserId)}</span>
            <span className="settle-arrow" aria-hidden="true">
              →
            </span>
            <span className="settle-direction-name">{nameOf(toUserId)}</span>
            <span className="settle-swap" aria-hidden="true">
              <SwapIcon />
            </span>
          </button>
        </div>
      ) : (
        <div className="form-grid">
          <div>
            <label htmlFor="settleFrom">Paid by</label>
            <select
              id="settleFrom"
              value={fromUserId}
              onChange={(e) => setFromUserId(e.target.value)}
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="settleTo">Paid to</label>
            <select
              id="settleTo"
              value={toUserId}
              onChange={(e) => setToUserId(e.target.value)}
            >
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="form-grid">
        <div>
          <label htmlFor="settleAmount">Amount</label>
          <input
            id="settleAmount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={decimalsFor(currency) === 0 ? "2000" : "20.00"}
            inputMode="decimal"
            autoFocus
            required
          />
        </div>
        <div>
          <label htmlFor="settleCurrency">Currency</label>
          <CurrencySelect id="settleCurrency" value={currency} onChange={setCurrency} codes={currencies} />
        </div>
      </div>

      <div>
        <div className="label-with-help">
          <label htmlFor="settleDate">Date</label>
          <HelpTip label="About this payment">
            This clears {currency} only. A balance in any other currency is a separate ledger and
            stays open.
          </HelpTip>
        </div>
        <input
          id="settleDate"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </div>

      <div>
        <label htmlFor="settleNote">Note (optional)</label>
        <input
          id="settleNote"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Cash at dinner"
          maxLength={500}
        />
        <p className="field-hint">Posted as a comment on this payment.</p>
      </div>

      <div>
        <button type="submit" disabled={busy || fromUserId === toUserId}>
          {busy
            ? "Recording…"
            : `Record ${nameOf(fromUserId)} → ${nameOf(toUserId)}`}
        </button>
      </div>
    </form>
  );
}
