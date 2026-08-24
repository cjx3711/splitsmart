/**
 * One friend: what stands between the two of you and everything you've split.
 *
 * Expenses here span every group plus the one-on-one ones; the question "what
 * is between us" does not stop at a group boundary. Shared groups are listed
 * from current membership, once — the totals card does not repeat them.
 * Settled ones are hidden behind "Show settled up groups" so the list stays
 * the groups that still have something between you.
 * New expenses added from this screen are one-on-one (no group).
 *
 * On a wide screen the totals and groups sit in a right-hand panel so the
 * expense list can start at the top. Narrow screens stack them, same order
 * as before: totals, groups, guest link, expenses.
 *
 * Adding and settling live in dialogs off the header rather than inline, so the
 * page stays a view of the balance instead of a stack of forms.
 *
 * Read from the mirror and written through the outbox, so both dialogs work with
 * no network. Only the guest-link panel is online-only.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useParams, Link } from "react-router-dom";
import { displayName, api, type ExpenseQuery, type GroupMember } from "../api.ts";
import { Amount, Amounts, useFormatMoney } from "../money.tsx";
import { AddExpenseDialog } from "../AddExpenseDialog.tsx";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { ExpenseFilters } from "../ExpenseFilters.tsx";
import {
  SettleUpDialog,
  friendSettleChoices,
  paymentAsExpense,
} from "../SettleUpDialog.tsx";
import { Avatar, avatarFromRow } from "../Avatar.tsx";
import { useAuth } from "../App.tsx";
import {
  useFriend,
  useFriendExpenses,
  useGroupMembers,
  useRelatedPeople,
  useSharedGroups,
} from "../localData.ts";
import { GroupTypeIcon, groupTypeLabel } from "../groupTypes.tsx";
import { useSync } from "../sync/SyncProvider.tsx";
import { patchPerson, revertPerson } from "../sync/localFirst.ts";
import { ulid } from "../../../src/domain/ulid.ts";
import { ConversionFootnote, EstimatedTotal } from "../ConversionNote.tsx";
import { ConvertBalanceDialog } from "../ConvertBalanceDialog.tsx";
import { LinkPanel } from "../LinkPanel.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { PersonIdentityDialog } from "../PersonIdentityDialog.tsx";
import { OnlineOnly } from "../OnlineOnly.tsx";
import { HelpTip } from "../HelpTip.tsx";
import { Skeleton } from "../Skeleton.tsx";

export function FriendDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | "convert" | "identity" | null>(
    null,
  );
  const [showSettledGroups, setShowSettledGroups] = useState(false);
  const [filters, setFilters] = useState<ExpenseQuery>({});
  const formatMoney = useFormatMoney();
  const { engine, syncNow, db } = useSync();

  useEffect(() => {
    setFilters({});
    setShowSettledGroups(false);
    setOpenDialog(null);
  }, [id]);

  const loaded = useFriend(id);
  const expensePage = useFriendExpenses(id, filters);
  const allFriends = useRelatedPeople()?.people ?? [];
  const sharedPage = useSharedGroups(id);
  const breakdownGroupIds = loaded?.friend.breakdown.map((entry) => entry.groupId) ?? [];
  const membersByGroup =
    useGroupMembers(breakdownGroupIds) ?? new Map<string, GroupMember[]>();

  // The whole page waits on the person. Expenses and shared groups can resolve
  // at different speeds; showing one friend's bills under another's name is
  // how a click-through looks broken. Filter changes only skeleton the list.
  if (loaded === undefined || sharedPage === undefined || !user) {
    return <Skeleton kind="friend" />;
  }
  if (loaded === null) return <p className="empty">This person is not on this device.</p>;

  const friend = loaded.friend;
  const sharedGroups = sharedPage.groups;

  const name = displayName(friend);
  const people = [
    { id: user.id, label: "You" },
    { id: friend.id, label: name },
  ];
  const nameOf = makeLookup(
    [
      { id: user.id, name: user.name, nickname: user.nickname },
      friend,
      ...allFriends,
    ],
    user.id,
  );

  const owed = [...friend.balances].sort(
    (a, b) => Math.abs(b.amountMinor) - Math.abs(a.amountMinor),
  );
  const currenciesInPlay = [
    ...new Set([...owed.map((b) => b.currencyCode), user.defaultCurrency]),
  ];
  const outstandingGroupIds = new Set(
    friend.breakdown
      .filter((entry) => entry.groupId && entry.balances.length > 0)
      .map((entry) => entry.groupId),
  );
  const settledSharedGroups = sharedGroups.filter((g) => !outstandingGroupIds.has(g.id));
  const visibleSharedGroups = showSettledGroups
    ? sharedGroups
    : sharedGroups.filter((g) => outstandingGroupIds.has(g.id));
  const sharedById = new Map(sharedGroups.map((g) => [g.id, g]));
  const leftoverGroups = friend.breakdown.filter(
    (entry) => entry.groupId !== null && !sharedById.has(entry.groupId),
  );
  const oneOnOne = friend.breakdown.find((entry) => entry.groupId === null);
  const listingGroups = visibleSharedGroups.length > 0 || leftoverGroups.length > 0;
  const showOneOnOne = Boolean(oneOnOne && oneOnOne.balances.length > 0 && listingGroups);
  const showGroupsSection = listingGroups || settledSharedGroups.length > 0;

  const othersOn = (groupId: string) =>
    (membersByGroup.get(groupId) ?? []).filter((m) => m.id !== user.id && m.id !== friend.id);

  const sourceRow = (
    key: string,
    to: string | undefined,
    icon: ReactNode,
    title: string,
    subtitle: ReactNode,
    figures: ReactNode,
  ) => {
    const inner = (
      <>
        {icon}
        <div className="list-item-body">
          <div className="list-item-title">{title}</div>
          {subtitle ? <div className="breakdown-sub">{subtitle}</div> : null}
        </div>
        <div className="list-item-figures">{figures}</div>
      </>
    );
    return to ? (
      <Link key={key} to={to} className="list-item">
        {inner}
      </Link>
    ) : (
      <div key={key} className="list-item">
        {inner}
      </div>
    );
  };

  return (
    <>
      <Breadcrumbs trail={[{ label: "Friends", to: "/friends" }, { label: name }]} />

      <div className="page-head">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <Avatar {...avatarFromRow(friend)} size={44} />
          <div>
            <h1>{name}</h1>
            <p className="muted" style={{ margin: 0 }}>
              {friend.nickname?.trim() && friend.nickname.trim() !== friend.name
                ? `${friend.name} · `
                : ""}
              {friend.email ?? "No email"}
              {friend.is_ghost === 1 && " · hasn't joined yet"}
            </p>
          </div>
        </div>
        <div className="page-actions">
          {friend.is_ghost === 1 && (
            <OnlineOnly what="Editing a placeholder's name">
              <button className="secondary" onClick={() => setOpenDialog("identity")}>
                Edit name
              </button>
            </OnlineOnly>
          )}
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
      />

      <PersonIdentityDialog
        open={openDialog === "identity"}
        person={friend}
        onClose={() => setOpenDialog(null)}
        onSave={async (id, payload) => {
          if (!db) {
            await api.updateFriend(id, payload);
            syncNow();
            return;
          }
          const previous = await patchPerson(db, id, payload);
          try {
            await api.updateFriend(id, payload);
            syncNow();
          } catch (err) {
            if (previous) await revertPerson(db, previous);
            throw err;
          }
        }}
      />

      <SettleUpDialog
        open={openDialog === "settle"}
        title={`Settle up with ${name}`}
        people={people}
        currencies={currenciesInPlay}
        preferredCurrency={user.defaultCurrency}
        choices={friendSettleChoices(owed, user.id, friend.id, name, formatMoney)}
        onClose={() => setOpenDialog(null)}
        onSubmit={async (payment) => {
          // A payment is an expense with is_payment set, so the outbox carries
          // it like any other. The pair is spelled out rather than sent as a
          // direction: the queue is a batch of writes, not a set of endpoints,
          // and "you_paid" would need the recipient inferred at replay time.
          if (!engine) throw new Error("Not ready to save yet.");
          await engine.enqueue({
            kind: "payment.create",
            id: ulid(),
            payload: paymentAsExpense(payment, null),
          });
        }}
      />

      <ConvertBalanceDialog
        open={openDialog === "convert"}
        themName={name}
        youId={user.id}
        themId={friend.id}
        balances={friend.balances}
        preferredCurrency={user.defaultCurrency}
        onClose={() => setOpenDialog(null)}
        onSubmit={async (payments) => {
          if (!engine) throw new Error("Not ready to save yet.");
          for (const payment of payments) {
            const id = ulid();
            await engine.enqueue({
              kind: "payment.create",
              id,
              payload: paymentAsExpense(payment, null),
            });
            await engine.enqueue({
              kind: "comment.create",
              id: ulid(),
              payload: { expenseId: id, content: payment.comment },
            });
          }
        }}
      />

      <div className="friend-page">
        <aside className="friend-aside">
          <div className="card">
            <span className="eyebrow">
              <span className="with-help">
                Between you
                <HelpTip label="About this balance">
                  In a group with simplify debts on, cycles through other people are collapsed, the same
                  way Splitwise does. Each bill still shows who paid.
                </HelpTip>
              </span>
            </span>
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
            <EstimatedTotal balances={friend.balances} preferredCurrency={user.defaultCurrency} />
            {friend.balances.length > 1 && (
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
            <ConversionFootnote sets={[friend.balances]} preferredCurrency={user.defaultCurrency} />
          </div>

          {showGroupsSection && (
            <>
              <h2>Shared groups</h2>
              {(listingGroups || showOneOnOne) && (
                <div className="list breakdown-list">
                  {visibleSharedGroups.map((g) => {
                    const entry = friend.breakdown.find((e) => e.groupId === g.id);
                    const others = othersOn(g.id);
                    return sourceRow(
                      g.id,
                      `/groups/${g.id}`,
                      <GroupTypeIcon type={g.group_type} className="nav-item-icon" />,
                      g.name.trim() || "Unnamed group",
                      <>
                        <span className="muted">{groupTypeLabel(g.group_type)}</span>
                        {others.length > 0 && (
                          <span className="avatar-stack">
                            {others.slice(0, 4).map((m) => (
                              <Avatar key={m.id} {...avatarFromRow(m)} size={20} />
                            ))}
                            {others.length > 4 && (
                              <span className="avatar-overflow">+{others.length - 4}</span>
                            )}
                          </span>
                        )}
                        {entry?.simplified && <span className="muted">simplified</span>}
                      </>,
                      entry && entry.balances.length > 0 ? (
                        <Amounts balances={entry.balances} signed />
                      ) : (
                        <span className="muted">settled up</span>
                      ),
                    );
                  })}
                  {leftoverGroups.map((entry) => {
                    const others = othersOn(entry.groupId!);
                    return sourceRow(
                      entry.groupId!,
                      `/groups/${entry.groupId}`,
                      <GroupTypeIcon type="other" className="nav-item-icon" />,
                      entry.groupName?.trim() || "Unnamed group",
                      <>
                        {others.length > 0 && (
                          <span className="avatar-stack">
                            {others.slice(0, 4).map((m) => (
                              <Avatar key={m.id} {...avatarFromRow(m)} size={20} />
                            ))}
                            {others.length > 4 && (
                              <span className="avatar-overflow">+{others.length - 4}</span>
                            )}
                          </span>
                        )}
                        {entry.simplified && <span className="muted">simplified</span>}
                      </>,
                      <Amounts balances={entry.balances} signed />,
                    );
                  })}
                  {showOneOnOne &&
                    oneOnOne &&
                    sourceRow(
                      "none",
                      undefined,
                      <span className="avatar-placeholder" aria-hidden="true" />,
                      "One-on-one",
                      null,
                      <Amounts balances={oneOnOne.balances} signed />,
                    )}
                </div>
              )}
              {settledSharedGroups.length > 0 && (
                <div className="ledger-actions ledger-actions-centered">
                  <button
                    type="button"
                    className="secondary inline compact"
                    aria-expanded={showSettledGroups}
                    onClick={() => setShowSettledGroups((open) => !open)}
                  >
                    {showSettledGroups ? "Hide settled up groups" : "Show settled up groups"}
                  </button>
                </div>
              )}
            </>
          )}
        </aside>

        <div className="friend-body">
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
          {/* No person picker: this screen IS "what is between the two of us", and
              the download says so too via csvScope. */}
          <ExpenseFilters
            value={filters}
            onChange={setFilters}
            csvScope={{ friendId: friend.id }}
            csvFilename={`splitsmart-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
          />
          {expensePage === undefined ? (
            <Skeleton kind="expenseList" />
          ) : (
            <ExpenseList
              expenses={expensePage.expenses}
              currentUserId={user.id}
              nameOf={nameOf}
              showGroup
              empty={
                Object.keys(filters).length > 0
                  ? "Nothing shared with them matches those filters."
                  : `Nothing split with ${name} yet.`
              }
            />
          )}
        </div>
      </div>
    </>
  );
}
