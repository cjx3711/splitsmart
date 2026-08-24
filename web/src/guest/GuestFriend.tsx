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
import { ExpenseDialog } from "../ExpenseDialog.tsx";
import {
  SettleUpDialog,
  friendSettleChoices,
} from "../SettleUpDialog.tsx";
import { Avatar, avatarFromRow } from "../Avatar.tsx";
import { GroupTypeIcon } from "../groupTypes.tsx";
import { ConversionFootnote, EstimatedTotal } from "../ConversionNote.tsx";
import { ConvertBalanceDialog } from "../ConvertBalanceDialog.tsx";
import { useGuest } from "./GuestApp.tsx";
import { guestApi, guestFullName, type GuestVisiblePerson } from "./guestApi.ts";

export function GuestFriend() {
  const { session } = useGuest();
  const me = session.actingAs!;
  const formatMoney = useFormatMoney();

  const [counterpart, setCounterpart] = useState<{
    id: string;
    name: string;
    nickname: string | null;
    icon_letters: string | null;
    icon_emoji: string | null;
    icon_hue: number | null;
    icon_pattern: import("../../../src/domain/avatar-pattern.ts").AvatarPattern | null;
  } | null>(null);
  const [balances, setBalances] = useState<CurrencyAmount[]>([]);
  const [expenses, setExpenses] = useState<ExpenseSummary[]>([]);
  // The expense list spans groups, so it names people who are neither of the
  // two on this page. Without them, a payer renders as "User 01ARZ3...".
  const [people, setPeople] = useState<GuestVisiblePerson[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | "convert" | null>(null);

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
          { id: me.id, name: me.name, nickname: me.nickname },
          {
            id: counterpart.id,
            name: counterpart.name,
            nickname: counterpart.nickname,
          },
        ],
    me.id,
  );

  const owed = [...balances].sort((a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor));
  const currenciesInPlay = [
    ...new Set([...owed.map((b) => b.currencyCode), me.defaultCurrency]),
  ];

  return (
    <>
      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Avatar {...avatarFromRow(counterpart)} size={44} />
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
      <ExpenseDialog
        open={openDialog === "expense"}
        title={`Add an expense with ${name}`}
        onClose={() => setOpenDialog(null)}
        candidates={pair}
        initialParticipantIds={[me.id, counterpart.id]}
        currentUserId={me.id}
        defaultCurrency={me.defaultCurrency}
        groupId={null}
        onSubmit={async (input) => {
          await guestApi.createExpense({ ...input, groupId: null });
          await load();
        }}
      />

      <SettleUpDialog
        open={openDialog === "settle"}
        title={`Settle up with ${name}`}
        people={pair}
        currencies={currenciesInPlay}
        preferredCurrency={me.defaultCurrency}
        choices={friendSettleChoices(owed, me.id, counterpart.id, name, formatMoney)}
        onClose={() => setOpenDialog(null)}
        onSubmit={async (payment) => {
          await guestApi.createPayment({ ...payment, groupId: null });
          await load();
        }}
      />

      <ConvertBalanceDialog
        open={openDialog === "convert"}
        themName={name}
        youId={me.id}
        themId={counterpart.id}
        balances={balances}
        preferredCurrency={me.defaultCurrency}
        onClose={() => setOpenDialog(null)}
        onSubmit={async (payments) => {
          for (const payment of payments) {
            const { id } = await guestApi.createPayment({ ...payment, groupId: null });
            await guestApi.addComment(id, payment.comment);
          }
          await load();
        }}
      />

      <div className="friend-page">
        <aside className="friend-aside">
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
            <EstimatedTotal balances={balances} preferredCurrency={me.defaultCurrency} />
            {balances.length > 1 && (
              <div className="ledger-actions">
                <button
                  type="button"
                  className="secondary inline"
                  onClick={() => setOpenDialog("convert")}
                >
                  Convert balance
                </button>
              </div>
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
        </aside>

        <div className="friend-body">
          <h2>Shared expenses</h2>
          <ExpenseList
            expenses={expenses}
            currentUserId={me.id}
            nameOf={nameOf}
            showGroup
            personLinks={false}
            empty="Nothing split yet."
          />
        </div>
      </div>
    </>
  );
}
