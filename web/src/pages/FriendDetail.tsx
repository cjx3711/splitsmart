/**
 * One friend: what stands between the two of you and everything you've split.
 *
 * Expenses here span every group plus the one-on-one ones; the question "what
 * is between us" does not stop at a group boundary. New expenses added from
 * this screen are one-on-one (no group).
 *
 * Adding and settling live in dialogs off the header rather than inline, so the
 * page stays a view of the balance instead of a stack of forms.
 */
import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, fullName, type Friend, type ExpenseSummary } from "../api.ts";
import { Amount, Amounts, useFormatMoney } from "../money.tsx";
import { AddExpenseDialog } from "../AddExpenseDialog.tsx";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { SettleUpForm } from "../SettleUpForm.tsx";
import { Modal } from "../Modal.tsx";
import { Avatar } from "../Avatar.tsx";
import { useAuth } from "../App.tsx";
import { ConversionFootnote, EstimatedTotal } from "../ConversionNote.tsx";
import { LinkPanel } from "../LinkPanel.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";

export function FriendDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const [friend, setFriend] = useState<Friend | null>(null);
  const [expenses, setExpenses] = useState<ExpenseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | null>(null);
  const [settleCurrency, setSettleCurrency] = useState<string | null>(null);
  const formatMoney = useFormatMoney();

  async function load() {
    if (!id) return;
    try {
      const [detail, list] = await Promise.all([
        api.getFriend(id),
        api.getFriendExpenses(id),
      ]);
      setFriend(detail.friend);
      setExpenses(list.expenses);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this friend");
    }
  }

  useEffect(() => {
    if (id) void load();
  }, [id]);

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

  // What you actually owe each other, biggest first, so the settle-up dialog
  // opens on the currency worth clearing rather than the alphabetical one.
  const owed = [...friend.balances].sort(
    (a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor),
  );
  const currenciesInPlay = [
    ...new Set([...owed.map((b) => b.currencyCode), user.defaultCurrency]),
  ];
  const top = owed[0];
  const selected = settleCurrency
    ? owed.find((b) => b.currencyCode === settleCurrency)
    : top;
  const showSettlePicker = owed.length > 1 && settleCurrency === null;

  function closeSettle() {
    setOpenDialog(null);
    setSettleCurrency(null);
  }

  return (
    <>
      <Breadcrumbs trail={[{ label: "Friends", to: "/friends" }, { label: name }]} />

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
        <div className="page-actions">
          <button className="secondary" onClick={() => setOpenDialog("settle")}>
            Settle up
          </button>
          <button onClick={() => setOpenDialog("expense")}>Add Expense</button>
        </div>
      </div>

      <AddExpenseDialog
        open={openDialog === "expense"}
        title={`Add Expense with ${name}`}
        initialFriendId={friend.id}
        onClose={() => setOpenDialog(null)}
        onCreated={load}
      />

      <Modal
        open={openDialog === "settle"}
        title={`Settle up with ${name}`}
        onClose={closeSettle}
      >
        {showSettlePicker ? (
          <div className="settle-currency-picker">
            <p className="muted" style={{ margin: 0 }}>
              Which balance do you want to settle? A payment only clears that currency.
            </p>
            {owed.map((b) => (
              <button
                key={b.currencyCode}
                type="button"
                className="secondary"
                onClick={() => setSettleCurrency(b.currencyCode)}
              >
                {b.amountMinor > 0 ? `${name} owes you ` : `You owe ${name} `}
                <Amount minor={b.amountMinor} currency={b.currencyCode} absolute />
              </button>
            ))}
          </div>
        ) : (
          <SettleUpForm
            className="stack"
            people={people}
            currencies={currenciesInPlay}
            preferredCurrency={user.defaultCurrency}
            initial={
              selected && {
                // A positive balance means they owe you, so they are the payer.
                fromUserId: selected.amountMinor > 0 ? friend.id : user.id,
                toUserId: selected.amountMinor > 0 ? user.id : friend.id,
                amount: formatMoney(Math.abs(selected.amountMinor), selected.currencyCode) ?? "",
                currencyCode: selected.currencyCode,
              }
            }
            onSubmit={async (payment) => {
              await api.createFriendPayment(friend.id, {
                // The friend endpoint takes a direction rather than a pair, since
                // a one-on-one payment can only run between the two of you.
                direction: payment.fromUserId === user.id ? "you_paid" : "they_paid",
                amountMinor: payment.amountMinor,
                currencyCode: payment.currencyCode,
                date: payment.date,
              });
              closeSettle();
              await load();
            }}
          />
        )}
      </Modal>

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
        {friend.balances.length > 1 && (
          <EstimatedTotal balances={friend.balances} preferredCurrency={user.defaultCurrency} />
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
        <ConversionFootnote sets={[friend.balances]} preferredCurrency={user.defaultCurrency} />
      </div>

      {/*
        Only a placeholder gets a link. Someone with their own account logs in;
        a link that acted as them would be an impersonation channel, and the
        server refuses to mint one.
      */}
      {friend.is_ghost === 1 && (
        <>
          <h2>Guest link</h2>
          <LinkPanel
            query={{ friendId: friend.id }}
            canManage
            slots={[
              {
                id: `friend-${friend.id}`,
                kind: "friend",
                userId: friend.id,
                label: `${name}'s link`,
                note: `They can open this without an account, or create one and claim the link to keep this history. Links expire after 3 months.`,
              },
            ]}
            intro="Share this link so they can view your shared expenses. Links expire after 3 months. If one is compromised, turn it off and create a new one."
          />
        </>
      )}

      <h2>Shared expenses</h2>
      <ExpenseList
        expenses={expenses}
        currentUserId={user.id}
        nameOf={nameOf}
        showGroup
        empty={`Nothing split with ${name} yet.`}
      />
    </>
  );
}
