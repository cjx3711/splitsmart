/**
 * Recording a payment, shared by the group and friend screens.
 *
 * A payment is an ordinary expense with is_payment = 1 (see
 * src/domain/expenses.ts), so it nets off through exactly the same balance
 * query as everything else. Nothing here is special-cased.
 *
 * A payment only clears the currency it is made in. Owing yen and paying in
 * dollars leaves both ledgers open — that follows from currencies never being
 * converted, and the form says so rather than letting people discover it.
 */
import { useState, type FormEvent } from "react";
import { useCurrencies, useParseMoney } from "./money.tsx";
import { CurrencySelect } from "./CurrencySelect.tsx";
import { type Payer } from "./ExpenseForm.tsx";

export interface SettlePayment {
  fromUserId: number;
  toUserId: number;
  amountMinor: number;
  currencyCode: string;
  date: string;
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
  initial?: { fromUserId: number; toUserId: number; amount: string; currencyCode: string };
  onSubmit: (payment: SettlePayment) => Promise<void>;
  className?: string;
}) {
  const parseInCurrency = useParseMoney();
  const { decimalsFor } = useCurrencies();

  const [fromUserId, setFromUserId] = useState(initial?.fromUserId ?? people[0]?.id ?? 0);
  const [toUserId, setToUserId] = useState(
    initial?.toUserId ?? people.find((p) => p.id !== (initial?.fromUserId ?? people[0]?.id))?.id ?? 0,
  );
  const [amount, setAmount] = useState(initial?.amount ?? "");
  const [currency, setCurrency] = useState(initial?.currencyCode ?? currencies[0] ?? "USD");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      await onSubmit({ fromUserId, toUserId, amountMinor, currencyCode: currency, date });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the payment");
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (id: number) => people.find((p) => p.id === id)?.label ?? "someone";

  return (
    <form onSubmit={handleSubmit} className={className}>
      {error && <p className="error">{error}</p>}

      <div className="form-grid">
        <div>
          <label htmlFor="settleFrom">Paid by</label>
          <select
            id="settleFrom"
            value={fromUserId}
            onChange={(e) => setFromUserId(Number(e.target.value))}
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
            onChange={(e) => setToUserId(Number(e.target.value))}
          >
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

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
        <label htmlFor="settleDate">Date</label>
        <input
          id="settleDate"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <p className="field-hint">
          This clears {currency} only. A balance in any other currency is a separate ledger and
          stays open.
        </p>
      </div>

      <div>
        <button type="submit" disabled={busy}>
          {busy
            ? "Recording…"
            : `Record ${nameOf(fromUserId)} → ${nameOf(toUserId)}`}
        </button>
      </div>
    </form>
  );
}
