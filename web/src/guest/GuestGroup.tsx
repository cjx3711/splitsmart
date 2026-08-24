/**
 * A group, seen through a guest link.
 *
 * The same shape as the logged-in group screen, minus everything a guest may
 * not do: no invite panel, no member management, no group settings. Those are
 * not merely hidden; there is no route on the guest API that would serve them.
 * See docs/GUEST.md, "Guest chrome".
 *
 * On a wide screen the member balances (the full roster, including people at
 * zero), suggested settle-up, and convert sit in a right-hand panel, matching
 * the logged-in group page.
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
import { avatarFromRow } from "../Avatar.tsx";
import { FriendListItem, groupRosterBalances, ledgerVerb } from "../FriendListItem.tsx";
import { groupTypeLabel } from "../groupTypes.tsx";
import { ConversionFootnote, EstimatedTotal } from "../ConversionNote.tsx";
import { ConvertGroupBalanceDialog } from "../ConvertBalanceDialog.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { groupCrumbs } from "./guestCrumbs.ts";
import { useGuest } from "./GuestApp.tsx";
import { guestApi, guestFullName, type GuestMember } from "./guestApi.ts";
import { HelpTip } from "../HelpTip.tsx";
import { Skeleton } from "../Skeleton.tsx";

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
  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | "convert" | null>(null);

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
  if (!group) return <Skeleton kind="group" />;

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
  const hasSettle = settle.some((s) => s.transfers.length > 0);
  const canConvert = outstandingCurrencies.length > 1;
  const roster = groupRosterBalances(
    members.map((m) => m.id),
    balances,
  );
  const convertTransfers = settle.flatMap((s) =>
    s.transfers.map((t) => ({
      currencyCode: s.currencyCode,
      fromUserId: t.fromUserId,
      toUserId: t.toUserId,
      amountMinor: t.amountMinor,
    })),
  );

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
        allowManual
        choices={groupSettleChoices(settle, nameOf, formatMoney)}
        onClose={() => setOpenDialog(null)}
        onSubmit={async (payment) => {
          await guestApi.createPayment({ ...payment, groupId: group.id });
          await load();
        }}
      />

      <ConvertGroupBalanceDialog
        open={openDialog === "convert"}
        nameOf={nameOf}
        transfers={convertTransfers}
        preferredCurrency={group.default_currency}
        onClose={() => setOpenDialog(null)}
        onSubmit={async (payments) => {
          for (const payment of payments) {
            const { id } = await guestApi.createPayment({ ...payment, groupId: group.id });
            await guestApi.addComment(id, payment.comment);
          }
          await load();
        }}
      />

      <div className="split-page">
          <aside className="split-aside">
            <h2 style={{ marginTop: 0 }}>Balances</h2>
              <div className="list">
                {roster.map((entry) => {
                  const member = members.find((m) => m.id === entry.userId);
                  return (
                    <FriendListItem
                      key={entry.userId}
                      avatar={
                        member
                          ? avatarFromRow(member)
                          : { id: entry.userId, name: nameOf(entry.userId) }
                      }
                      title={nameOf(entry.userId)}
                    >
                      {entry.balances.length === 0 ? (
                        <span className="muted">settled up</span>
                      ) : (
                      <div>
                        <div className="ledger">
                          {entry.balances.map((b) => (
                            <div
                              key={b.currencyCode}
                              className={b.amountMinor >= 0 ? "positive" : "negative"}
                            >
                              {ledgerVerb(entry.userId === me.id, b.amountMinor)}
                              <Amount minor={b.amountMinor} currency={b.currencyCode} absolute />
                            </div>
                          ))}
                        </div>
                        <EstimatedTotal
                          balances={entry.balances}
                          preferredCurrency={me.defaultCurrency}
                        />
                      </div>
                      )}
                    </FriendListItem>
                  );
                })}
              </div>
            <ConversionFootnote
              sets={roster.map((e) => e.balances)}
              preferredCurrency={me.defaultCurrency}
            />
            {canConvert && (
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
            {hasSettle && (
              <>
                <h2 className="with-help">
                  Suggested settle-up
                  <HelpTip label="About suggested settle-up">
                    The fewest transfers that clear this group, one set per currency. Nothing is recorded
                    until someone actually pays. Use Settle up above, which starts prefilled with the
                    first of these.
                  </HelpTip>
                </h2>
                <div className="card stack">
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
          </aside>

        <div className="split-body">
      <h2 style={{ marginTop: 0 }}>Expenses</h2>
      <ExpenseList
        expenses={expenses}
        currentUserId={me.id}
        nameOf={nameOf}
        personLinks={false}
      />
        </div>
      </div>
    </>
  );
}
