/**
 * One friend: what stands between the two of you, everything you've split, and
 * the forms to add to it or settle it.
 *
 * Expenses here span every group plus the one-on-one ones — the question "what
 * is between us" does not stop at a group boundary. New expenses added from
 * this screen are one-on-one (no group).
 */
import { useEffect, useState, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { api, fullName, type Friend, type ExpenseSummary } from "../api.ts";
import { Amount, Amounts, useCurrencies, useParseMoney } from "../money.tsx";
import { ExpenseForm } from "../ExpenseForm.tsx";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { Avatar } from "../Avatar.tsx";
import { useAuth } from "../App.tsx";

export function FriendDetail() {
  const { id } = useParams<{ id: string }>();
  const friendId = Number(id);
  const { user } = useAuth();

  const [friend, setFriend] = useState<Friend | null>(null);
  const [expenses, setExpenses] = useState<ExpenseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [detail, list] = await Promise.all([
        api.getFriend(friendId),
        api.getFriendExpenses(friendId),
      ]);
      setFriend(detail.friend);
      setExpenses(list.expenses);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this friend");
    }
  }

  useEffect(() => {
    if (Number.isInteger(friendId)) void load();
  }, [friendId]);

  if (error) return <p className="error">{error}</p>;
  if (!friend || !user) return <p className="muted">Loading…</p>;

  const name = fullName(friend);
  const people = [
    { id: user.id, label: "You" },
    { id: friend.id, label: name },
  ];
  const nameOf = makeLookup(
    [
      { id: user.id, first_name: user.firstName, last_name: user.lastName },
      { id: friend.id, first_name: friend.first_name, last_name: friend.last_name },
    ],
    user.id,
  );

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Avatar id={friend.id} name={name} size={44} />
          <div>
            <h1>{name}</h1>
            <p className="muted" style={{ margin: 0 }}>
              {friend.email ?? "No email"}
              {friend.is_ghost === 1 && " · hasn't joined yet"}
            </p>
          </div>
        </div>
      </div>

      <div className="card">
        <span className="eyebrow">Between you</span>
        {friend.balances.length === 0 ? (
          <p className="muted" style={{ margin: "0.4rem 0 0" }}>
            You're settled up.
          </p>
        ) : (
          <div className="ledger" style={{ marginTop: "0.4rem" }}>
            {friend.balances.map((b) => (
              <div key={b.currencyCode} className="ledger-row">
                <span className={b.amountMinor > 0 ? "positive" : "negative"}>
                  {b.amountMinor > 0 ? `${name} owes you ` : `You owe ${name} `}
                  <Amount minor={b.amountMinor} currency={b.currencyCode} absolute />
                </span>
              </div>
            ))}
          </div>
        )}

        {friend.breakdown.length > 1 && (
          <ul className="breakdown" style={{ marginTop: "0.6rem" }}>
            {friend.breakdown.map((entry) => (
              <li key={entry.groupId ?? "none"}>
                <Amounts balances={entry.balances} signed /> in{" "}
                {entry.groupId ? (
                  <Link to={`/groups/${entry.groupId}`}>{entry.groupName}</Link>
                ) : (
                  "one-on-one expenses"
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <h2>Settle up</h2>
      <SettleUp friend={friend} onSettled={load} />

      <h2>Add a one-on-one expense</h2>
      <ExpenseForm
        people={people}
        currentUserId={user.id}
        defaultCurrency={user.defaultCurrency}
        onSubmit={async (input) => {
          await api.createFriendExpense(friendId, input);
          await load();
        }}
      />

      <h2>Shared expenses</h2>
      <ExpenseList
        expenses={expenses}
        currentUserId={user.id}
        nameOf={nameOf}
        showGroup
        onDeleted={load}
        empty={`Nothing split with ${name} yet.`}
      />
    </>
  );
}

/**
 * Records a payment between the two of you.
 *
 * A payment is an ordinary expense with is_payment = 1 (see
 * src/domain/expenses.ts), so it nets off through exactly the same balance
 * query as everything else.
 */
function SettleUp({ friend, onSettled }: { friend: Friend; onSettled: () => void }) {
  const { user } = useAuth();
  const parseInCurrency = useParseMoney();
  const { decimalsFor } = useCurrencies();

  // Default to whichever direction actually clears something.
  const owing = friend.balances[0];
  const [direction, setDirection] = useState<"you_paid" | "they_paid">(
    owing && owing.amountMinor < 0 ? "you_paid" : "they_paid",
  );
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(
    owing?.currencyCode ?? user?.defaultCurrency ?? "USD",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = fullName(friend);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

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
      await api.createFriendPayment(friend.id, { direction, amountMinor, currencyCode: currency });
      setAmount("");
      onSettled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the payment");
    } finally {
      setBusy(false);
    }
  }

  const currencyOptions = friend.balances.length
    ? friend.balances.map((b) => b.currencyCode)
    : [user?.defaultCurrency ?? "USD"];

  return (
    <form onSubmit={handleSubmit} className="card stack">
      {error && <p className="error">{error}</p>}

      <div className="form-grid">
        <div>
          <label htmlFor="direction">Who paid</label>
          <select
            id="direction"
            value={direction}
            onChange={(e) => setDirection(e.target.value as "you_paid" | "they_paid")}
          >
            <option value="you_paid">You paid {name}</option>
            <option value="they_paid">{name} paid you</option>
          </select>
        </div>
        <div>
          <label htmlFor="settleAmount">Amount</label>
          <input
            id="settleAmount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={decimalsFor(currency) === 0 ? "2000" : "20.00"}
            inputMode="decimal"
            required
          />
        </div>
      </div>

      <div>
        <label htmlFor="settleCurrency">Currency</label>
        <select
          id="settleCurrency"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
        >
          {currencyOptions.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </select>
        <p className="field-hint">
          A payment only clears the currency it's made in. Owing yen and paying in dollars leaves
          both ledgers open.
        </p>
      </div>

      <div>
        <button type="submit" disabled={busy} className="inline">
          {busy ? "Recording…" : "Record payment"}
        </button>
      </div>
    </form>
  );
}
