/**
 * The add-expense form, shared by the group and friend screens.
 *
 * Only the equal split is exposed. The server already supports exact, percent,
 * shares and adjustment (src/domain/split.ts) — see docs/PLAN.md phase 2 for
 * the UI. `splitType` is still sent explicitly rather than defaulted so the
 * shape does not have to change when the others arrive.
 *
 * Amounts are parsed against the SELECTED currency's decimal places, not a
 * hardcoded 2. Typing 1000 with JPY selected means one thousand yen.
 */
import { useEffect, useState, type FormEvent } from "react";
import { type ExpenseInput } from "./api.ts";
import { useCurrencies, useParseMoney } from "./money.tsx";

/**
 * A placeholder in the selected currency's own precision.
 *
 * Typing "30.00" with JPY selected is rejected — correctly, since yen has no
 * subunit — so the hint must not suggest it in the first place.
 */
function amountPlaceholder(decimals: number | null): string {
  if (decimals === null) return "30";
  return decimals === 0 ? "3000" : `30.${"0".repeat(decimals)}`;
}

export interface Payer {
  id: number;
  label: string;
}

export function ExpenseForm({
  people,
  defaultCurrency,
  currentUserId,
  onSubmit,
  submitLabel = "Add expense",
}: {
  people: Payer[];
  defaultCurrency: string;
  currentUserId: number;
  onSubmit: (input: ExpenseInput) => Promise<void>;
  submitLabel?: string;
}) {
  const { currencies, decimalsFor } = useCurrencies();
  const parseInCurrency = useParseMoney();

  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payerId, setPayerId] = useState(currentUserId);
  const [involved, setInvolved] = useState<number[]>(() => people.map((p) => p.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setCurrency(defaultCurrency), [defaultCurrency]);
  useEffect(() => {
    setInvolved(people.map((p) => p.id));
    setPayerId((current) => (people.some((p) => p.id === current) ? current : currentUserId));
  }, [people, currentUserId]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    let costMinor: number;
    try {
      costMinor = parseInCurrency(amount, currency);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid amount");
      return;
    }

    if (costMinor <= 0) return setError("Amount must be greater than zero");
    if (!involved.includes(payerId)) return setError("The payer has to be part of the split");

    setBusy(true);
    try {
      await onSubmit({
        description: description.trim(),
        costMinor,
        currencyCode: currency,
        date,
        splitType: "equal",
        // The payer covers the whole cost; everyone involved shares it equally.
        participants: involved.map((userId) => ({
          userId,
          paidMinor: userId === payerId ? costMinor : 0,
        })),
      });
      setDescription("");
      setAmount("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add expense");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card stack">
      {error && <p className="error">{error}</p>}

      <div>
        <label htmlFor="description">Description</label>
        <input
          id="description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Dinner"
          required
        />
      </div>

      <div className="form-grid">
        <div>
          <label htmlFor="amount">Amount</label>
          <input
            id="amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={amountPlaceholder(decimalsFor(currency))}
            inputMode="decimal"
            required
          />
        </div>
        <div>
          <label htmlFor="currency">Currency</label>
          <select id="currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
            {currencies.map((c) => (
              <option key={c.code} value={c.code}>
                {c.code}
                {c.symbol ? ` · ${c.symbol}` : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="form-grid">
        <div>
          <label htmlFor="date">Date</label>
          <input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div>
          <label htmlFor="payer">Paid by</label>
          <select id="payer" value={payerId} onChange={(e) => setPayerId(Number(e.target.value))}>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <label>Split equally between</label>
        {people.map((p) => (
          <div key={p.id} className="participant">
            <input
              type="checkbox"
              id={`involved-${p.id}`}
              checked={involved.includes(p.id)}
              onChange={(e) =>
                setInvolved((prev) =>
                  e.target.checked ? [...prev, p.id] : prev.filter((x) => x !== p.id),
                )
              }
            />
            <label htmlFor={`involved-${p.id}`}>{p.label}</label>
          </div>
        ))}
      </div>

      <div>
        <button type="submit" disabled={busy || involved.length === 0} className="inline">
          {busy ? "Adding…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
