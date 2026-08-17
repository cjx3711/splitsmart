/**
 * One friend: what stands between the two of you and everything you've split.
 *
 * Expenses here span every group plus the one-on-one ones — the question "what
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

export function FriendDetail() {
  const { id } = useParams<{ id: string }>();
  const friendId = Number(id);
  const { user } = useAuth();

  const [friend, setFriend] = useState<Friend | null>(null);
  const [expenses, setExpenses] = useState<ExpenseSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | null>(null);
  const formatMoney = useFormatMoney();

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

  // What you actually owe each other, biggest first, so the settle-up dialog
  // opens on the currency worth clearing rather than the alphabetical one.
  const owed = [...friend.balances].sort(
    (a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor),
  );
  const currenciesInPlay = [
    ...new Set([...owed.map((b) => b.currencyCode), user.defaultCurrency]),
  ];
  const top = owed[0];

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
        <div className="page-actions">
          <button className="secondary" onClick={() => setOpenDialog("settle")}>
            Settle up
          </button>
          <button onClick={() => setOpenDialog("expense")}>Add an expense</button>
        </div>
      </div>

      <AddExpenseDialog
        open={openDialog === "expense"}
        title={`Add an expense with ${name}`}
        initialFriendId={friendId}
        onClose={() => setOpenDialog(null)}
        onCreated={load}
      />

      <Modal
        open={openDialog === "settle"}
        title={`Settle up with ${name}`}
        onClose={() => setOpenDialog(null)}
      >
        <SettleUpForm
          className="stack"
          people={people}
          currencies={currenciesInPlay}
          initial={
            top && {
              // A positive balance means they owe you, so they are the payer.
              fromUserId: top.amountMinor > 0 ? friend.id : user.id,
              toUserId: top.amountMinor > 0 ? user.id : friend.id,
              amount: formatMoney(Math.abs(top.amountMinor), top.currencyCode) ?? "",
              currencyCode: top.currencyCode,
            }
          }
          onSubmit={async (payment) => {
            await api.createFriendPayment(friendId, {
              // The friend endpoint takes a direction rather than a pair, since
              // a one-on-one payment can only run between the two of you.
              direction: payment.fromUserId === user.id ? "you_paid" : "they_paid",
              amountMinor: payment.amountMinor,
              currencyCode: payment.currencyCode,
              date: payment.date,
            });
            setOpenDialog(null);
            await load();
          }}
        />
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
