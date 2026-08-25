/**
 * One group: balances, suggested settle-up, expenses, guest links.
 *
 * Everything on the left of the offline/online line in docs/OFFLINE.md is read
 * from the mirror and written through the outbox - the balances and the settle-up
 * suggestions are derived here with the same pure functions the server uses, not
 * fetched. Minting a guest link stays online-only, and says so. Adding, editing
 * and removing members live on the Options page.
 *
 * On a wide screen the member balances (the full roster, including people at
 * zero), suggested settle-up, and convert sit in a right-hand panel so the
 * expense list can start higher. Narrow screens stack them, with balances still
 * above the expenses.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { displayName, type ExpenseQuery } from "../api.ts";
import { LinkPanel, type LinkSlot } from "../LinkPanel.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { useFormatMoney } from "../money.tsx";
import { AddExpenseDialog } from "../AddExpenseDialog.tsx";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { ExpenseFilters } from "../ExpenseFilters.tsx";
import {
  SettleUpDialog,
  groupSettleChoices,
  paymentAsExpense,
} from "../SettleUpDialog.tsx";
import { GroupTypeIcon, groupTypeLabel } from "../groupTypes.tsx";
import { avatarFromRow } from "../Avatar.tsx";
import { useAuth } from "../App.tsx";
import { OnlineOnly, useOnline } from "../OnlineOnly.tsx";
import { useGroupExpenses, useGroupView, useSettleSuggestions } from "../localData.ts";
import { setGroupSimplify } from "../groupSettings.ts";
import { useSync } from "../sync/SyncProvider.tsx";
import { ulid } from "../../../src/domain/ulid.ts";
import { ConversionFootnote } from "../ConversionNote.tsx";
import { RosterBalance, SettleSuggestion } from "../GroupBalances.tsx";
import { ConvertGroupBalanceDialog } from "../ConvertBalanceDialog.tsx";
import { enqueuePayment } from "../recordPayment.ts";
import { FriendListItem, friendHref, groupRosterBalances } from "../FriendListItem.tsx";
import { Skeleton } from "../Skeleton.tsx";
import { PlusIcon } from "../Icons.tsx";

export function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | "convert" | null>(null);
  // Which suggested transfer the dialog should open on. Cleared when Settle up
  // is pressed from the header, which starts at the picker.
  const [settleChoice, setSettleChoice] = useState<string | undefined>(undefined);
  const [filters, setFilters] = useState<ExpenseQuery>({});
  const formatMoney = useFormatMoney();
  const { engine, db, syncNow } = useSync();
  const online = useOnline();

  useEffect(() => {
    setFilters({});
    setOpenDialog(null);
    setSettleChoice(undefined);
  }, [id]);

  // Live queries: a sync landing, or a queued write, re-renders this screen
  // without anything having to invalidate anything.
  const view = useGroupView(id);
  const expensePage = useGroupExpenses(id, filters);
  const settlePage = useSettleSuggestions(id);

  // Identity and balances wait together. Expenses can arrive a tick later;
  // those skeleton on their own so a filter change does not blank the roster.
  if (view === undefined || settlePage === undefined || !user) {
    return <Skeleton kind="group" />;
  }
  if (view === null) return <p className="empty">This group is not on this device.</p>;

  const { group, members, balances, role } = view;
  const settle = settlePage.suggestions;
  const nameOf = makeLookup(members, user.id);
  const people = members.map((m) => ({
    id: m.id,
    label: m.id === user.id ? "You" : displayName(m),
  }));
  const avatarFor = (userId: string) => {
    const member = members.find((m) => m.id === userId);
    return member ? avatarFromRow(member) : { id: userId, name: nameOf(userId) };
  };

  // Currencies this group actually holds balances in, with its default first so
  // a group that is fully settled still offers something sensible.
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
  const simplified = group.simplify_by_default === 1;
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

  const isOwner = role === "owner";

  // One general link, plus one per PLACEHOLDER member. Someone with their own
  // account is not impersonable by a shared secret, so they get a note instead
  // of a link the server would refuse to mint.
  const linkSlots: LinkSlot[] = [
    {
      id: "general",
      kind: "group",
      groupId: group.id,
      label: "Anyone with the link",
      note: "They pick which name they are, and can change it later.",
    },
    ...members
      .filter((m) => m.is_ghost === 1)
      .map((m) => ({
        id: `member-${m.id}`,
        kind: "group_member" as const,
        groupId: group.id,
        userId: m.id,
        label: `${displayName(m)} only`,
        note: "Opens straight as them, with no picker.",
      })),
  ];

  return (
    <>
      <Breadcrumbs trail={[{ label: "Groups", to: "/groups" }, { label: group.name }]} />

      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <GroupTypeIcon type={group.group_type} className="group-page-icon" />
          <div>
            <h1>{group.name}</h1>
            <p className="muted" style={{ margin: 0 }}>
              {groupTypeLabel(group.group_type)} · default {group.default_currency} · {members.length}{" "}
              {members.length === 1 ? "member" : "members"}
            </p>
          </div>
        </div>
        <div className="page-actions">
          <button
            type="button"
            className="secondary"
            onClick={() => navigate(`/groups/${group.id}/options`)}
          >
            Options
          </button>
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

      <AddExpenseDialog
        open={openDialog === "expense"}
        title={`New expense in ${group.name}`}
        initialGroupId={group.id}
        onClose={() => setOpenDialog(null)}
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
        onSubmit={async (payment) => {
          // A payment is an ordinary expense with is_payment set: the payer
          // fronts the whole cost and the recipient owes all of it, which is
          // what cancels an equivalent slice of the balance. Queued like any
          // other write, so settling up works at the table.
          await enqueuePayment(engine, payment, group.id);
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
          if (!engine) throw new Error("Not ready to save yet.");
          for (const payment of payments) {
            const id = ulid();
            await engine.enqueue({
              kind: "payment.create",
              id,
              payload: paymentAsExpense(payment, group.id),
            });
            await engine.enqueue({
              kind: "comment.create",
              id: ulid(),
              payload: { expenseId: id, content: payment.comment },
            });
          }
        }}
      />

      <div className="split-page">
          <aside className="split-aside">
            {hasSettle && (
              <SettleSuggestion
                settle={settle}
                nameOf={nameOf}
                currentUserId={user.id}
                simplified={simplified}
                onPick={(choiceId) => {
                  setSettleChoice(choiceId);
                  setOpenDialog("settle");
                }}
                // Both shortcuts need the network, so offline they are not
                // offered rather than offered and refused.
                onSimplify={
                  simplified || !online || !db
                    ? undefined
                    : () => {
                        void setGroupSimplify(db, group.id, true)
                          .then(() => syncNow())
                          .catch(() => undefined);
                      }
                }
                onConvert={online ? () => setOpenDialog("convert") : undefined}
                convertTo={{ code: group.default_currency, label: "this group's default currency" }}
              />
            )}

            <h2 style={hasSettle ? undefined : { marginTop: 0 }}>Balances</h2>
              <div className="list">
                {roster.map((entry) => (
                  <FriendListItem
                    key={entry.userId}
                    to={friendHref(entry.userId, user.id)}
                    avatar={avatarFor(entry.userId)}
                    title={nameOf(entry.userId)}
                    subtitle={
                      members.find((m) => m.id === entry.userId)?.is_ghost === 1 ? (
                        <span className="tag muted">guest</span>
                      ) : undefined
                    }
                  >
                    <RosterBalance
                      balances={entry.balances}
                      isYou={entry.userId === user.id}
                      preferredCurrency={user.defaultCurrency}
                    />
                  </FriendListItem>
                ))}
              </div>
            <ConversionFootnote
              sets={roster.map((e) => e.balances)}
              preferredCurrency={user.defaultCurrency}
              settingsHref="/settings"
            />
            {canConvert && (
              <div className="ledger-actions">
                <OnlineOnly what="Converting a balance">
                  <button
                    type="button"
                    className="secondary inline"
                    onClick={() => setOpenDialog("convert")}
                  >
                    Convert balance
                  </button>
                </OnlineOnly>
              </div>
            )}
          </aside>

        <div className="split-body">
      <h2 style={{ marginTop: 0 }}>Expenses</h2>
      {/* No group picker: this screen IS the group scope, and a filter cannot
          widen it. The CSV carries the same filters as the list. */}
      <ExpenseFilters
        value={filters}
        onChange={setFilters}
        payers={members}
        csvScope={{ groupId: group.id }}
        csvFilename={`splitsmart-${group.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
      />
      {expensePage === undefined ? (
        <Skeleton kind="expenseList" />
      ) : (
        <ExpenseList
          expenses={expensePage.expenses}
          currentUserId={user.id}
          nameOf={nameOf}
          empty={
            Object.keys(filters).length > 0
              ? "Nothing in this group matches those filters."
              : "Nothing yet."
          }
        />
      )}

      <h2>Guest links</h2>
      <LinkPanel
        query={{ groupId: group.id }}
        canManage={isOwner}
        slots={linkSlots}
        intro={
          isOwner
            ? "Guest links expire after 3 months. Anyone holding one can see and edit this group's expenses, so share them carefully. Turn one off or replace it anytime - if a link is compromised, revoke it and create a new one."
            : "Only the group owner can create or turn off guest links."
        }
      />
        </div>
      </div>

    </>
  );
}
