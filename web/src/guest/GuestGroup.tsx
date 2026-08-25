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
import { useFormatMoney } from "../money.tsx";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { ExpenseDialog } from "../ExpenseDialog.tsx";
import {
  SettleUpDialog,
  groupSettleChoices,
} from "../SettleUpDialog.tsx";
import { avatarFromRow } from "../Avatar.tsx";
import { FriendListItem, groupRosterBalances } from "../FriendListItem.tsx";
import { groupTypeLabel } from "../groupTypes.tsx";
import { ConversionFootnote } from "../ConversionNote.tsx";
import { RosterBalance, SettleSuggestion } from "../GroupBalances.tsx";
import { ConvertGroupBalanceDialog } from "../ConvertBalanceDialog.tsx";
import { PlusIcon } from "../Icons.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { groupCrumbs } from "./guestCrumbs.ts";
import { useGuest } from "./GuestApp.tsx";
import { guestApi, guestFullName, type GuestMember } from "./guestApi.ts";
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
    simplify_by_default: number;
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
  // The suggested transfer the dialog opens on, when one was clicked.
  const [settleChoice, setSettleChoice] = useState<string | undefined>(undefined);

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
          <button
            className="secondary"
            onClick={() => {
              setSettleChoice(undefined);
              setOpenDialog("settle");
            }}
          >
            <PlusIcon /> Payment
          </button>
          <button onClick={() => setOpenDialog("expense")}>
            <PlusIcon /> Expense
          </button>
        </div>
      </div>

      <ExpenseDialog
        open={openDialog === "expense"}
        title={`New expense in ${group.name}`}
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
        title={`New payment in ${group.name}`}
        people={people}
        currencies={currenciesInPlay}
        allowManual
        choices={groupSettleChoices(settle, nameOf, formatMoney)}
        initialChoiceId={settleChoice}
        onClose={() => setOpenDialog(null)}
        onSubmit={async ({ note, ...payment }) => {
          // The note is not a column on the payment: it is posted as a comment
          // on it, the same as the logged-in screens do.
          const { id } = await guestApi.createPayment({ ...payment, groupId: group.id });
          if (note) await guestApi.addComment(id, note);
          await load();
        }}
      />

      <ConvertGroupBalanceDialog
        open={openDialog === "convert"}
        nameOf={nameOf}
        transfers={convertTransfers}
        preferredCurrency={group.default_currency}
        defaultLabel="this group's default currency"
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
            {hasSettle && (
              <SettleSuggestion
                settle={settle}
                nameOf={nameOf}
                currentUserId={me.id}
                simplified={group.simplify_by_default === 1}
                onPick={(choiceId) => {
                  setSettleChoice(choiceId);
                  setOpenDialog("settle");
                }}
                // No onSimplify: a link holder cannot change group settings.
                onConvert={() => setOpenDialog("convert")}
                convertTo={{ code: group.default_currency, label: "this group's default currency" }}
              />
            )}

            <h2 style={hasSettle ? undefined : { marginTop: 0 }}>Balances</h2>
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
                      subtitle={
                        member?.is_ghost === 1 ? (
                          <span className="tag muted">guest</span>
                        ) : undefined
                      }
                    >
                      <RosterBalance
                        balances={entry.balances}
                        isYou={entry.userId === me.id}
                        preferredCurrency={me.defaultCurrency}
                      />
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
