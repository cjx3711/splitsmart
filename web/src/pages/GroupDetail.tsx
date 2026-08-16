import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  fullName,
  type Group,
  type GroupMember,
  type ExpenseSummary,
  type CurrencyAmount,
} from "../api.ts";
import { Amount } from "../money.tsx";
import { ExpenseForm } from "../ExpenseForm.tsx";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { Avatar } from "../Avatar.tsx";
import { useAuth } from "../App.tsx";

export function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const groupId = Number(id);
  const { user } = useAuth();

  const [group, setGroup] = useState<(Group & { inviteUrl: string | null }) | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [balances, setBalances] = useState<Array<{ userId: number; balances: CurrencyAmount[] }>>([]);
  const [expenses, setExpenses] = useState<ExpenseSummary[]>([]);
  const [settle, setSettle] = useState<
    Array<{
      currencyCode: string;
      transfers: Array<{ fromUserId: number; toUserId: number; amountMinor: number }>;
    }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const [detail, expenseList, suggestions] = await Promise.all([
        api.getGroup(groupId),
        api.getGroupExpenses(groupId),
        api.getSettleSuggestions(groupId),
      ]);
      setGroup(detail.group);
      setMembers(detail.members);
      setBalances(detail.balances);
      setExpenses(expenseList.expenses);
      setSettle(suggestions.suggestions);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load group");
    }
  }

  useEffect(() => {
    if (Number.isInteger(groupId)) void load();
  }, [groupId]);

  if (error) return <p className="error">{error}</p>;
  if (!group || !user) return <p className="muted">Loading…</p>;

  const nameOf = makeLookup(members, user.id);
  const people = members.map((m) => ({
    id: m.id,
    label: m.id === user.id ? "You" : fullName(m),
  }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{group.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {group.group_type} · default {group.default_currency} · {members.length}{" "}
            {members.length === 1 ? "member" : "members"}
          </p>
        </div>
      </div>

      <h2 style={{ marginTop: 0 }}>Balances</h2>
      {balances.length === 0 ? (
        <p className="empty">Everyone is settled up.</p>
      ) : (
        <div className="list">
          {balances.map((entry) => (
            <div key={entry.userId} className="list-item">
              <Avatar id={entry.userId} name={nameOf(entry.userId)} />
              <div className="list-item-body">
                <div className="list-item-title">{nameOf(entry.userId)}</div>
              </div>
              <div className="ledger">
                {entry.balances.map((b) => (
                  <div key={b.currencyCode} className={b.amountMinor >= 0 ? "positive" : "negative"}>
                    {b.amountMinor >= 0 ? "gets back " : "owes "}
                    <Amount minor={b.amountMinor} currency={b.currencyCode} absolute />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {settle.some((s) => s.transfers.length > 0) && (
        <>
          <h2>Suggested settle-up</h2>
          <div className="card stack">
            <p className="muted" style={{ margin: 0 }}>
              The fewest transfers that clear this group, one set per currency. Nothing is recorded
              until someone actually pays.
            </p>
            {settle
              .filter((s) => s.transfers.length > 0)
              .map((s) => (
                <div key={s.currencyCode}>
                  <span className="eyebrow">{s.currencyCode}</span>
                  <ul className="breakdown">
                    {s.transfers.map((t, i) => (
                      <li key={i}>
                        {nameOf(t.fromUserId)} → {nameOf(t.toUserId)}{" "}
                        <Amount minor={t.amountMinor} currency={s.currencyCode} />
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
          </div>
        </>
      )}

      <h2>Add an expense</h2>
      <ExpenseForm
        people={people}
        currentUserId={user.id}
        defaultCurrency={group.default_currency}
        onSubmit={async (input) => {
          await api.createExpense(groupId, input);
          await load();
        }}
      />

      <h2>Expenses</h2>
      <ExpenseList
        expenses={expenses}
        currentUserId={user.id}
        nameOf={nameOf}
        onDeleted={load}
      />

      <h2>Members</h2>
      <div className="list">
        {members.map((m) => (
          <div key={m.id} className="list-item">
            <Avatar id={m.id} name={fullName(m)} />
            <div className="list-item-body">
              <div className="list-item-title">{m.id === user.id ? "You" : fullName(m)}</div>
              <div className="muted">
                {m.role}
                {m.is_ghost === 1 && " · guest"}
              </div>
            </div>
          </div>
        ))}
      </div>

      {group.inviteUrl && (
        <>
          <h2>Invite link</h2>
          <div className="card stack">
            <p className="muted" style={{ margin: 0 }}>
              Anyone with this link can join the group and read every expense in it. Sharing it is
              the only way in — there is no per-person invite for groups.
            </p>
            <code>{group.inviteUrl}</code>
            <div>
              <button
                className="secondary inline"
                onClick={() => {
                  void navigator.clipboard.writeText(group.inviteUrl!).then(() => setCopied(true));
                }}
              >
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
