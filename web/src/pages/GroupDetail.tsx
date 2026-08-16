import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  formatMoney,
  parseMoney,
  type Group,
  type GroupMember,
  type ExpenseSummary,
  type CurrencyAmount,
} from "../api.ts";
import { useAuth } from "../App.tsx";

export function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const groupId = Number(id);
  const { user } = useAuth();

  const [group, setGroup] = useState<(Group & { inviteUrl: string | null }) | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [balances, setBalances] = useState<Array<{ userId: number; balances: CurrencyAmount[] }>>([]);
  const [expenses, setExpenses] = useState<ExpenseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [detail, expenseList] = await Promise.all([
        api.getGroup(groupId),
        api.getGroupExpenses(groupId),
      ]);
      setGroup(detail.group);
      setMembers(detail.members);
      setBalances(detail.balances);
      setExpenses(expenseList.expenses);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load group");
    }
  }

  useEffect(() => {
    if (Number.isInteger(groupId)) void load();
  }, [groupId]);

  if (error) return <p className="error">{error}</p>;
  if (!group) return <p className="muted">Loading…</p>;

  const nameOf = (userId: number) => {
    const member = members.find((m) => m.id === userId);
    if (!member) return `User ${userId}`;
    if (member.id === user?.id) return "You";
    return [member.first_name, member.last_name].filter(Boolean).join(" ");
  };

  return (
    <>
      <h1>{group.name}</h1>
      <p className="muted">
        {group.group_type} · {group.default_currency} · {members.length} members
      </p>

      <h2>Balances</h2>
      {balances.length === 0 ? (
        <p className="muted">Everyone is settled up.</p>
      ) : (
        <div className="stack">
          {balances.map((entry) => (
            <div key={entry.userId} className="card row">
              <span>{nameOf(entry.userId)}</span>
              <span>
                {entry.balances.map((b) => (
                  <div key={b.currencyCode} className={b.amountMinor >= 0 ? "positive" : "negative"}>
                    {b.amountMinor >= 0 ? "gets back " : "owes "}
                    {formatMoney(Math.abs(b.amountMinor))} {b.currencyCode}
                  </div>
                ))}
              </span>
            </div>
          ))}
        </div>
      )}

      <AddExpense
        groupId={groupId}
        members={members}
        defaultCurrency={group.default_currency}
        currentUserId={user?.id ?? 0}
        onAdded={load}
      />

      <h2>Expenses</h2>
      {expenses.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <div className="stack">
          {expenses.map((expense) => (
            <div key={expense.id} className="card row">
              <div>
                <strong>{expense.description}</strong>
                <div className="muted">
                  {expense.date.split("T")[0]}
                  {expense.category_name && ` · ${expense.category_name}`}
                  {expense.is_payment === 1 && " · payment"}
                </div>
              </div>
              <span>
                {formatMoney(expense.cost_minor)} {expense.currency_code}
              </span>
            </div>
          ))}
        </div>
      )}

      {group.inviteUrl && (
        <>
          <h2>Invite link</h2>
          <div className="card stack">
            <p className="muted" style={{ margin: 0 }}>
              Anyone with this link can join the group and see its expenses.
            </p>
            <code>{group.inviteUrl}</code>
            <button
              className="secondary"
              onClick={() => void navigator.clipboard.writeText(group.inviteUrl!)}
            >
              Copy link
            </button>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Equal-split expense form.
 *
 * Only "equal" is exposed here; the server supports exact/percent/shares/
 * adjustment already (see src/domain/split.ts) and the UI for those is
 * tracked in docs/PLAN.md phase 2.
 */
function AddExpense({
  groupId,
  members,
  defaultCurrency,
  currentUserId,
  onAdded,
}: {
  groupId: number;
  members: GroupMember[];
  defaultCurrency: string;
  currentUserId: number;
  onAdded: () => void;
}) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payerId, setPayerId] = useState(currentUserId);
  const [involved, setInvolved] = useState<number[]>(() => members.map((m) => m.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setInvolved(members.map((m) => m.id));
  }, [members]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    let costMinor: number;
    try {
      costMinor = parseMoney(amount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid amount");
      return;
    }

    if (costMinor <= 0) return setError("Amount must be greater than zero");
    if (!involved.includes(payerId)) return setError("The payer must be involved in the expense");

    setBusy(true);
    try {
      await api.createExpense(groupId, {
        description: description.trim(),
        costMinor,
        currencyCode: defaultCurrency,
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
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add expense");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Add expense</h2>
      <form onSubmit={handleSubmit} className="stack">
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

        <div>
          <label htmlFor="amount">Amount ({defaultCurrency})</label>
          <input
            id="amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="30.00"
            inputMode="decimal"
            required
          />
        </div>

        <div>
          <label htmlFor="date">Date</label>
          <input id="date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>

        <div>
          <label htmlFor="payer">Paid by</label>
          <select id="payer" value={payerId} onChange={(e) => setPayerId(Number(e.target.value))}>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id === currentUserId ? "You" : [m.first_name, m.last_name].filter(Boolean).join(" ")}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label>Split equally between</label>
          {members.map((m) => (
            <div key={m.id} className="participant">
              <input
                type="checkbox"
                id={`involved-${m.id}`}
                checked={involved.includes(m.id)}
                onChange={(e) =>
                  setInvolved((prev) =>
                    e.target.checked ? [...prev, m.id] : prev.filter((x) => x !== m.id),
                  )
                }
              />
              <label htmlFor={`involved-${m.id}`} style={{ margin: 0 }}>
                {m.id === currentUserId ? "You" : [m.first_name, m.last_name].filter(Boolean).join(" ")}
              </label>
            </div>
          ))}
        </div>

        <button type="submit" disabled={busy || involved.length === 0}>
          {busy ? "Adding…" : "Add expense"}
        </button>
      </form>
    </>
  );
}
