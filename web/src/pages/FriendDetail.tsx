/**
 * One friend: what stands between the two of you and everything you've split.
 *
 * Expenses here span every group plus the one-on-one ones; the question "what
 * is between us" does not stop at a group boundary. Shared groups are listed
 * from current membership, including settled ones the balance breakdown omits.
 * New expenses added from this screen are one-on-one (no group).
 *
 * Adding and settling live in dialogs off the header rather than inline, so the
 * page stays a view of the balance instead of a stack of forms.
 *
 * Read from the mirror and written through the outbox, so both dialogs work with
 * no network. Only the guest-link panel is online-only.
 */
import { useState } from "react";
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
  useFriends,
  useGroupMembers,
  useSharedGroups,
} from "../localData.ts";
import { GroupTypeIcon, groupTypeLabel } from "../groupTypes.tsx";
import { useSync } from "../sync/SyncProvider.tsx";
import { patchPerson, revertPerson } from "../sync/localFirst.ts";
import { ulid } from "../../../src/domain/ulid.ts";
import { ConversionFootnote, EstimatedTotal } from "../ConversionNote.tsx";
import { LinkPanel } from "../LinkPanel.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { PersonIdentityDialog } from "../PersonIdentityDialog.tsx";
import { OnlineOnly } from "../OnlineOnly.tsx";
import { HelpTip } from "../HelpTip.tsx";

export function FriendDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | "identity" | null>(null);
  const [filters, setFilters] = useState<ExpenseQuery>({});
  const formatMoney = useFormatMoney();
  const { engine, syncNow, db } = useSync();

  const loaded = useFriend(id);
  const expenses = useFriendExpenses(id, filters)?.expenses ?? [];
  const allFriends = useFriends()?.friends ?? [];
  const sharedGroups = useSharedGroups(id)?.groups ?? [];
  const breakdownGroupIds = loaded?.friend.breakdown.map((entry) => entry.groupId) ?? [];
  const membersByGroup =
    useGroupMembers(breakdownGroupIds) ?? new Map<string, GroupMember[]>();

  if (loaded === undefined || !user) return <p className="muted">Loading…</p>;
  if (loaded === null) return <p className="empty">This person is not on this device.</p>;

  const friend = loaded.friend;

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
              <button
                className="secondary"
                onClick={() => setOpenDialog("identity")}
              >
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
        {friend.balances.length > 1 && (
          <EstimatedTotal balances={friend.balances} preferredCurrency={user.defaultCurrency} />
        )}

        {friend.breakdown.length > 1 && (
          <div className="list breakdown-list" style={{ marginTop: "0.6rem" }}>
            {friend.breakdown.map((entry) => {
              const groupType = entry.groupId
                ? sharedGroups.find((g) => g.id === entry.groupId)?.group_type
                : undefined;
              // Everyone else on the bill: the two people this page is already
              // about would just repeat the header, so they're left off.
              const others = (entry.groupId ? membersByGroup.get(entry.groupId) ?? [] : []).filter(
                (m) => m.id !== user.id && m.id !== friend.id,
              );

              const row = (
                <>
                  {entry.groupId ? (
                    <GroupTypeIcon type={groupType ?? "other"} className="nav-item-icon" />
                  ) : (
                    <span className="avatar-placeholder" aria-hidden="true" />
                  )}
                  <div className="list-item-body">
                    <div className="list-item-title">
                      {entry.groupId ? entry.groupName?.trim() || "Unnamed group" : "One-on-one"}
                    </div>
                    {(others.length > 0 || entry.simplified) && (
                      <div className="breakdown-sub">
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
                      </div>
                    )}
                  </div>
                  <div className="list-item-figures">
                    <Amounts balances={entry.balances} signed />
                  </div>
                </>
              );

              return entry.groupId ? (
                <Link key={entry.groupId} to={`/groups/${entry.groupId}`} className="list-item">
                  {row}
                </Link>
              ) : (
                <div key="none" className="list-item">
                  {row}
                </div>
              );
            })}
          </div>
        )}
        <ConversionFootnote sets={[friend.balances]} preferredCurrency={user.defaultCurrency} />
      </div>

      {sharedGroups.length > 0 && (
        <>
          <h2>Shared groups</h2>
          <div className="list">
            {sharedGroups.map((g) => {
              const bucket = friend.breakdown.find((entry) => entry.groupId === g.id);
              return (
                <Link key={g.id} to={`/groups/${g.id}`} className="list-item">
                  <GroupTypeIcon type={g.group_type} className="nav-item-icon" />
                  <div className="list-item-body">
                    <div className="list-item-title">{g.name}</div>
                    <div className="muted">{groupTypeLabel(g.group_type)}</div>
                  </div>
                  {bucket && bucket.balances.length > 0 ? (
                    <div className="list-item-figures">
                      <Amounts balances={bucket.balances} signed />
                    </div>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </>
      )}

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
      <ExpenseList
        expenses={expenses}
        currentUserId={user.id}
        nameOf={nameOf}
        showGroup
        empty={
          Object.keys(filters).length > 0
            ? "Nothing shared with them matches those filters."
            : `Nothing split with ${name} yet.`
        }
      />
    </>
  );
}
