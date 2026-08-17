/**
 * The friend-link home: you and whoever sent you the link.
 *
 * A friend link is the wide one, so this page shows both surfaces: what stands
 * between the two of you, and every group you are in. It is still not "the
 * owner's whole account": groups you are not in, and their other friends, are
 * not in the scope and never come back from the API.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { CurrencyAmount, ExpenseSummary } from "../api.ts";
import { Amount, useFormatMoney } from "../money.tsx";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { SettleUpForm } from "../SettleUpForm.tsx";
import { Modal } from "../Modal.tsx";
import { Avatar } from "../Avatar.tsx";
import { GroupTypeIcon } from "../groupTypes.tsx";
import { ConversionFootnote, EstimatedTotal } from "../ConversionNote.tsx";
import { GuestExpenseDialog } from "./GuestExpenseDialog.tsx";
import { useGuest } from "./GuestApp.tsx";
import { guestApi, guestFullName } from "./guestApi.ts";

export function GuestFriend() {
  const { session } = useGuest();
  const me = session.actingAs!;
  const formatMoney = useFormatMoney();

  const [counterpart, setCounterpart] = useState<{
    id: string;
    first_name: string;
    last_name: string | null;
  } | null>(null);
  const [balances, setBalances] = useState<CurrencyAmount[]>([]);
  const [expenses, setExpenses] = useState<ExpenseSummary[]>([]);
  // The expense list spans groups, so it names people who are neither of the
  // two on this page. Without them, a payer renders as "User 01ARZ3...".
  const [people, setPeople] = useState<
    Array<{ id: string; first_name: string; last_name: string | null }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | null>(null);

  const load = useCallback(async () => {
    try {
      const [detail, everyone] = await Promise.all([guestApi.friend(), guestApi.people()]);
      setCounterpart(detail.counterpart);
      setBalances(detail.balances);
      setExpenses(detail.expenses);
      setPeople(everyone.people);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!counterpart) return <p className="muted">Loading…</p>;

  const name = guestFullName(counterpart);
  const pair = [
    { id: me.id, label: "You" },
    { id: counterpart.id, label: name },
  ];
  const nameOf = makeLookup(
    people.length > 0
      ? people
      : [
          { id: me.id, first_name: me.firstName, last_name: me.lastName },
          {
            id: counterpart.id,
            first_name: counterpart.first_name,
            last_name: counterpart.last_name,
          },
        ],
    me.id,
  );

  const owed = [...balances].sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor));
  const top = owed[0];
  const currenciesInPlay = [
    ...new Set([...owed.map((b) => b.currencyCode), me.defaultCurrency]),
  ];

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Avatar id={counterpart.id} name={name} size={44} />
          <div>
            <h1>You and {name}</h1>
            <p className="muted" style={{ margin: 0 }}>
              Everything the two of you have split, plus the groups you share.
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

      {/*
        groupId is null: the only 1:1 relationship a friend link describes is
        the one between these two. A group expense is added from that group's
        own page, which is where the members list lives.
      */}
      <GuestExpenseDialog
        open={openDialog === "expense"}
        title={`Add an expense with ${name}`}
        onClose={() => setOpenDialog(null)}
        candidates={pair}
        initialParticipantIds={[me.id, counterpart.id]}
        currentUserId={me.id}
        defaultCurrency={me.defaultCurrency}
        groupId={null}
        onSubmit={async (input) => {
          await guestApi.createExpense(input);
          await load();
        }}
      />

      <Modal
        open={openDialog === "settle"}
        title={`Settle up with ${name}`}
        onClose={() => setOpenDialog(null)}
      >
        <SettleUpForm
          className="stack"
          people={pair}
          currencies={currenciesInPlay}
          preferredCurrency={me.defaultCurrency}
          initial={
            top && {
              // Positive means they owe you, so they are the payer.
              fromUserId: top.amountMinor > 0 ? counterpart.id : me.id,
              toUserId: top.amountMinor > 0 ? me.id : counterpart.id,
              amount: formatMoney(Math.abs(top.amountMinor), top.currencyCode) ?? "",
              currencyCode: top.currencyCode,
            }
          }
          onSubmit={async (payment) => {
            await guestApi.createPayment({ ...payment, groupId: null });
            setOpenDialog(null);
            await load();
          }}
        />
      </Modal>

      <div className="card">
        <span className="eyebrow">Between you</span>
        {balances.length === 0 ? (
          <p className="muted" style={{ margin: "0.4rem 0 0" }}>
            You're settled up.
          </p>
        ) : (
          <div className="ledger" style={{ marginTop: "0.4rem" }}>
            {balances.map((b) => (
              <div key={b.currencyCode} className="ledger-row">
                <span className={b.amountMinor > 0 ? "positive" : "negative"}>
                  {b.amountMinor > 0 ? `${name} owes you ` : `You owe ${name} `}
                  <Amount minor={b.amountMinor} currency={b.currencyCode} absolute />
                </span>
              </div>
            ))}
          </div>
        )}
        {balances.length > 1 && (
          <EstimatedTotal balances={balances} preferredCurrency={me.defaultCurrency} />
        )}
        <ConversionFootnote sets={[balances]} preferredCurrency={me.defaultCurrency} />
      </div>

      {session.groups.length > 0 && (
        <>
          <h2>Your groups</h2>
          <div className="list">
            {session.groups.map((g) => (
              <Link key={g.id} to={`/groups/${g.id}`} className="list-item">
                <GroupTypeIcon type={g.group_type} className="nav-item-icon" />
                <div className="list-item-body">
                  <div className="list-item-title">{g.name}</div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <h2>Shared expenses</h2>
      <ExpenseList
        expenses={expenses}
        currentUserId={me.id}
        nameOf={nameOf}
        showGroup
        personLinks={false}
        empty="Nothing split yet."
      />
    </>
  );
}
