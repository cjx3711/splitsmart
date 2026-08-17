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
import { Amount, useFormatMoney } from "../money.tsx";
import { AddExpenseDialog } from "../AddExpenseDialog.tsx";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { SettleUpForm } from "../SettleUpForm.tsx";
import { Modal } from "../Modal.tsx";
import { groupTypeLabel } from "../groupTypes.tsx";
import { Avatar } from "../Avatar.tsx";
import { useAuth } from "../App.tsx";
import { ConversionFootnote, EstimatedTotal } from "../ConversionNote.tsx";

export function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const [group, setGroup] = useState<(Group & { inviteUrl: string | null }) | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [balances, setBalances] = useState<Array<{ userId: string; balances: CurrencyAmount[] }>>([]);
  const [expenses, setExpenses] = useState<ExpenseSummary[]>([]);
  const [settle, setSettle] = useState<
    Array<{
      currencyCode: string;
      transfers: Array<{ fromUserId: string; toUserId: string; amountMinor: number }>;
    }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | null>(null);
  const [settleCurrency, setSettleCurrency] = useState<string | null>(null);
  const formatMoney = useFormatMoney();

  async function load() {
    if (!id) return;
    try {
      const [detail, expenseList, suggestions] = await Promise.all([
        api.getGroup(id),
        api.getGroupExpenses(id),
        api.getSettleSuggestions(id),
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
    if (id) void load();
  }, [id]);

  if (error) return <p className="error">{error}</p>;
  if (!group || !user) return <p className="muted">Loading…</p>;

  const nameOf = makeLookup(members, user.id);
  const people = members.map((m) => ({
    id: m.id,
    label: m.id === user.id ? "You" : fullName(m),
  }));

  // Currencies this group actually holds balances in, with its default first so
  // a group that is fully settled still offers something sensible.
  const currenciesInPlay = [
    ...new Set([
      group.default_currency,
      ...balances.flatMap((b) => b.balances.map((x) => x.currencyCode)),
    ]),
  ];

  // Prefill the settle-up dialog from the largest suggested transfer, so the
  // usual case is one click and a confirm rather than three dropdowns.
  const topTransfer = settle.flatMap((s) =>
    s.transfers.map((t) => ({ ...t, currencyCode: s.currencyCode })),
  )[0];

  const outstandingCurrencies = [
    ...new Set(balances.flatMap((e) => e.balances.map((b) => b.currencyCode))),
  ];
  const showSettlePicker = outstandingCurrencies.length > 1 && settleCurrency === null;
  const activeCurrency = settleCurrency ?? (outstandingCurrencies.length <= 1 ? outstandingCurrencies[0] : null);
  const activeTransfer = activeCurrency
    ? settle.find((s) => s.currencyCode === activeCurrency)?.transfers[0]
    : topTransfer;

  function closeSettle() {
    setOpenDialog(null);
    setSettleCurrency(null);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{group.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {groupTypeLabel(group.group_type)} · default {group.default_currency} · {members.length}{" "}
            {members.length === 1 ? "member" : "members"}
          </p>
        </div>
        <div className="page-actions">
          <button className="secondary" onClick={() => setOpenDialog("settle")}>
            Settle up
          </button>
          <button onClick={() => setOpenDialog("expense")}>Add an expense</button>
        </div>
      </div>

      <AddExpenseDialog
        open={openDialog === "expense"}
        title={`Add an expense to ${group.name}`}
        initialGroupId={group.id}
        onClose={() => setOpenDialog(null)}
        onCreated={load}
      />

      <Modal
        open={openDialog === "settle"}
        title={`Settle up in ${group.name}`}
        onClose={closeSettle}
      >
        {showSettlePicker ? (
          <div className="settle-currency-picker">
            <p className="muted" style={{ margin: 0 }}>
              Which balance do you want to settle? A payment only clears that currency.
            </p>
            {outstandingCurrencies.map((code) => {
              const transfer = settle.find((s) => s.currencyCode === code)?.transfers[0];
              return (
                <button
                  key={code}
                  type="button"
                  className="secondary"
                  onClick={() => setSettleCurrency(code)}
                >
                  {transfer ? (
                    <>
                      {nameOf(transfer.fromUserId)} → {nameOf(transfer.toUserId)}{" "}
                      <Amount minor={transfer.amountMinor} currency={code} />
                    </>
                  ) : (
                    code
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <SettleUpForm
            className="stack"
            people={people}
            currencies={currenciesInPlay}
            preferredCurrency={user.defaultCurrency}
            initial={
              activeTransfer && activeCurrency
                ? {
                    fromUserId: activeTransfer.fromUserId,
                    toUserId: activeTransfer.toUserId,
                    amount: formatMoney(activeTransfer.amountMinor, activeCurrency) ?? "",
                    currencyCode: activeCurrency,
                  }
                : activeCurrency
                  ? {
                      fromUserId: people[0]?.id ?? "",
                      toUserId: people[1]?.id ?? "",
                      amount: "",
                      currencyCode: activeCurrency,
                    }
                  : topTransfer && {
                      fromUserId: topTransfer.fromUserId,
                      toUserId: topTransfer.toUserId,
                      amount: formatMoney(topTransfer.amountMinor, topTransfer.currencyCode) ?? "",
                      currencyCode: topTransfer.currencyCode,
                    }
            }
            onSubmit={async (payment) => {
              await api.createGroupPayment(group.id, payment);
              closeSettle();
              await load();
            }}
          />
        )}
      </Modal>

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
              <div>
                <div className="ledger">
                  {entry.balances.map((b) => (
                    <div key={b.currencyCode} className={b.amountMinor >= 0 ? "positive" : "negative"}>
                      {b.amountMinor >= 0 ? "gets back " : "owes "}
                      <Amount minor={b.amountMinor} currency={b.currencyCode} absolute />
                    </div>
                  ))}
                </div>
                <EstimatedTotal balances={entry.balances} preferredCurrency={user.defaultCurrency} />
              </div>
            </div>
          ))}
        </div>
      )}
      <ConversionFootnote
        sets={balances.map((e) => e.balances)}
        preferredCurrency={user.defaultCurrency}
      />

      {settle.some((s) => s.transfers.length > 0) && (
        <>
          <h2>Suggested settle-up</h2>
          <div className="card stack">
            <p className="muted" style={{ margin: 0 }}>
              The fewest transfers that clear this group, one set per currency. Nothing is recorded
              until someone actually pays. Use <strong>Settle up</strong> above, which starts
              prefilled with the first of these.
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

      <h2>Expenses</h2>
      <ExpenseList
        expenses={expenses}
        currentUserId={user.id}
        nameOf={nameOf}
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
              the only way in; there is no per-person invite for groups.
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
