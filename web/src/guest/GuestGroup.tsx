/**
 * A group, seen through a guest link.
 *
 * The same shape as the logged-in group screen, minus everything a guest may
 * not do: no invite panel, no member management, no group settings. Those are
 * not merely hidden; there is no route on the guest API that would serve them.
 * See docs/GUEST.md, "Guest chrome".
 */
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { CurrencyAmount, ExpenseSummary } from "../api.ts";
import { Amount, useFormatMoney } from "../money.tsx";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { ExpenseDialog } from "../ExpenseDialog.tsx";
import {
  SettleUpDialog,
  groupSettleChoices,
} from "../SettleUpDialog.tsx";
import { Avatar, avatarFromRow } from "../Avatar.tsx";
import { groupTypeLabel } from "../groupTypes.tsx";
import { ConversionFootnote, EstimatedTotal } from "../ConversionNote.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { groupCrumbs } from "./guestCrumbs.ts";
import { useGuest } from "./GuestApp.tsx";
import { guestApi, guestFullName, type GuestMember } from "./guestApi.ts";
import { HelpTip } from "../HelpTip.tsx";

export function GuestGroup() {
  const { id } = useParams<{ id: string }>();
  const { session } = useGuest();
  const me = session.actingAs!;
  const formatMoney = useFormatMoney();

  const [group, setGroup] = useState<{
    id: string;
    name: string;
    group_type: string;
    default_currency: string;
  } | null>(null);
  const [members, setMembers] = useState<GuestMember[]>([]);
  const [balances, setBalances] = useState<Array<{ userId: string; balances: CurrencyAmount[] }>>([]);
  const [expenses, setExpenses] = useState<ExpenseSummary[]>([]);
  const [settle, setSettle] = useState<
    Array<{
      currencyCode: string;
      transfers: Array<{ fromUserId: string; toUserId: string; amountMinor: number }>;
    }>
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [detail, suggestions] = await Promise.all([
        guestApi.group(id),
        guestApi.settleSuggestions(id),
      ]);
      setGroup(detail.group);
      setMembers(detail.members);
      setBalances(detail.balances);
      setExpenses(detail.expenses);
      setSettle(suggestions.suggestions);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this group");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!group) return <p className="muted">Loading…</p>;

  const nameOf = makeLookup(members, me.id);
  const people = members.map((m) => ({
    id: m.id,
    label: m.id === me.id ? "You" : guestFullName(m),
  }));

  const currenciesInPlay = [
    ...new Set([
      group.default_currency,
      ...balances.flatMap((b) => b.balances.map((x) => x.currencyCode)),
    ]),
  ];

  const outstandingCurrencies = [
    ...new Set(balances.flatMap((e) => e.balances.map((b) => b.currencyCode))),
  ];

  return (
    <>
      <Breadcrumbs trail={groupCrumbs(session, group.name)} />

      <div className="page-head">
        <div>
          <h1>{group.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {groupTypeLabel(group.group_type)} · default {group.default_currency} ·{" "}
            {members.length} {members.length === 1 ? "member" : "members"}
          </p>
        </div>
        <div className="page-actions">
          <button className="secondary" onClick={() => setOpenDialog("settle")}>
            Settle up
          </button>
          <button onClick={() => setOpenDialog("expense")}>Add an expense</button>
        </div>
      </div>

      <ExpenseDialog
        open={openDialog === "expense"}
        title={`Add an expense to ${group.name}`}
        onClose={() => setOpenDialog(null)}
        candidates={people}
        initialParticipantIds={people.map((p) => p.id)}
        currentUserId={me.id}
        defaultCurrency={group.default_currency}
        groupId={group.id}
        onSubmit={async (input) => {
          await guestApi.createExpense({ ...input, groupId: group.id });
          await load();
        }}
      />

      <SettleUpDialog
        open={openDialog === "settle"}
        title={`Settle up in ${group.name}`}
        people={people}
        currencies={currenciesInPlay}
        preferredCurrency={me.defaultCurrency}
        choices={groupSettleChoices(
          outstandingCurrencies,
          settle,
          nameOf,
          people,
          formatMoney,
        )}
        onClose={() => setOpenDialog(null)}
        onSubmit={async (payment) => {
          await guestApi.createPayment({ ...payment, groupId: group.id });
          await load();
        }}
      />

      <h2 style={{ marginTop: 0 }}>Balances</h2>
      {balances.length === 0 ? (
        <p className="empty">Everyone is settled up.</p>
      ) : (
        <div className="list">
          {balances.map((entry) => {
            const member = members.find((m) => m.id === entry.userId);
            return (
            <div key={entry.userId} className="list-item">
              <Avatar
                {...(member
                  ? avatarFromRow(member)
                  : { id: entry.userId, name: nameOf(entry.userId) })}
              />
              <div className="list-item-body">
                <div className="list-item-title">{nameOf(entry.userId)}</div>
              </div>
              <div>
                <div className="ledger">
                  {entry.balances.map((b) => (
                    <div
                      key={b.currencyCode}
                      className={b.amountMinor >= 0 ? "positive" : "negative"}
                    >
                      {b.amountMinor >= 0 ? "gets back " : "owes "}
                      <Amount minor={b.amountMinor} currency={b.currencyCode} absolute />
                    </div>
                  ))}
                </div>
                <EstimatedTotal balances={entry.balances} preferredCurrency={me.defaultCurrency} />
              </div>
            </div>
            );
          })}
        </div>
      )}
      <ConversionFootnote
        sets={balances.map((e) => e.balances)}
        preferredCurrency={me.defaultCurrency}
      />

      <h2>Expenses</h2>
      <ExpenseList
        expenses={expenses}
        currentUserId={me.id}
        nameOf={nameOf}
        personLinks={false}
      />

      <h2 className="with-help">
        Members
        <HelpTip label="About members">
          Only someone with an account can add or remove people here.
        </HelpTip>
      </h2>
      <div className="list">
        {members.map((m) => (
          <div key={m.id} className="list-item">
            <Avatar {...avatarFromRow(m)} />
            <div className="list-item-body">
              <div className="list-item-title">{m.id === me.id ? "You" : guestFullName(m)}</div>
              <div className="muted">
                {m.role}
                {m.is_ghost === 1 && " · guest"}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
