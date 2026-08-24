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
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { displayName, type ExpenseQuery } from "../api.ts";
import { LinkPanel, type LinkSlot } from "../LinkPanel.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { Amount, useFormatMoney } from "../money.tsx";
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
import { OnlineOnly } from "../OnlineOnly.tsx";
import { useGroupExpenses, useGroupView, useSettleSuggestions } from "../localData.ts";
import { useSync } from "../sync/SyncProvider.tsx";
import { ulid } from "../../../src/domain/ulid.ts";
import { ConversionFootnote, EstimatedTotal } from "../ConversionNote.tsx";
import { ConvertGroupBalanceDialog } from "../ConvertBalanceDialog.tsx";
import { HelpTip } from "../HelpTip.tsx";
import { FriendListItem, friendHref, groupRosterBalances, ledgerVerb } from "../FriendListItem.tsx";
import { Skeleton } from "../Skeleton.tsx";

export function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();

  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | "convert" | null>(null);
  const [filters, setFilters] = useState<ExpenseQuery>({});
  const formatMoney = useFormatMoney();
  const { engine } = useSync();

  // Live queries: a sync landing, or a queued write, re-renders this screen
  // without anything having to invalidate anything.
  const view = useGroupView(id);
  const expenses = useGroupExpenses(id, filters)?.expenses ?? [];
  const settle = useSettleSuggestions(id)?.suggestions ?? [];

  if (view === undefined || !user) return <Skeleton kind="group" />;
  if (view === null) return <p className="empty">This group is not on this device.</p>;

  const { group, members, balances, role } = view;
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
          <button className="secondary" onClick={() => setOpenDialog("settle")}>
            Settle up
          </button>
          <button onClick={() => setOpenDialog("expense")}>Add Expense</button>
        </div>
      </div>

      <AddExpenseDialog
        open={openDialog === "expense"}
        title={`Add Expense to ${group.name}`}
        initialGroupId={group.id}
        onClose={() => setOpenDialog(null)}
      />

      <SettleUpDialog
        open={openDialog === "settle"}
        title={`Settle up in ${group.name}`}
        people={people}
        currencies={currenciesInPlay}
        preferredCurrency={user.defaultCurrency}
        allowManual
        choices={groupSettleChoices(settle, nameOf, formatMoney)}
        onClose={() => setOpenDialog(null)}
        onSubmit={async (payment) => {
          // A payment is an ordinary expense with is_payment set: the payer
          // fronts the whole cost and the recipient owes all of it, which is
          // what cancels an equivalent slice of the balance. Queued like any
          // other write, so settling up works at the table.
          if (!engine) throw new Error("Not ready to save yet.");
          await engine.enqueue({
            kind: "payment.create",
            id: ulid(),
            payload: paymentAsExpense(payment, group.id),
          });
        }}
      />

      <ConvertGroupBalanceDialog
        open={openDialog === "convert"}
        nameOf={nameOf}
        transfers={convertTransfers}
        preferredCurrency={group.default_currency}
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
            <h2 style={{ marginTop: 0 }}>Balances</h2>
              <div className="list">
                {roster.map((entry) => (
                  <FriendListItem
                    key={entry.userId}
                    to={friendHref(entry.userId, user.id)}
                    avatar={avatarFor(entry.userId)}
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
                            {ledgerVerb(entry.userId === user.id, b.amountMinor)}
                            <Amount minor={b.amountMinor} currency={b.currencyCode} absolute />
                          </div>
                        ))}
                      </div>
                      <EstimatedTotal
                        balances={entry.balances}
                        preferredCurrency={user.defaultCurrency}
                      />
                    </div>
                    )}
                  </FriendListItem>
                ))}
              </div>
            <ConversionFootnote
              sets={roster.map((e) => e.balances)}
              preferredCurrency={user.defaultCurrency}
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
      {/* No group picker: this screen IS the group scope, and a filter cannot
          widen it. The CSV carries the same filters as the list. */}
      <ExpenseFilters
        value={filters}
        onChange={setFilters}
        csvScope={{ groupId: group.id }}
        csvFilename={`splitsmart-${group.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
      />
      <ExpenseList
        expenses={expenses}
        currentUserId={user.id}
        nameOf={nameOf}
        empty={
          Object.keys(filters).length > 0
            ? "Nothing in this group matches those filters."
            : "Nothing yet."
        }
      />

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
