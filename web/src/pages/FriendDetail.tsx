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
 * page stays a view of the balance instead of a stack of forms. Settle-all is
 * the exception, and is offered as a note under the balance it explains: it
 * only exists when simplify has left cancelling amounts in separate buckets,
 * which is confusing enough that a bare button would raise more questions than
 * it answers.
 *
 * Recording a settle-up here can CREATE that state rather than find it: the
 * payment is one-on-one, so bringing a currency to zero between the two of you
 * leaves any shared group still reading as owed. The page offers to close those
 * out in the same breath, but ASKS first - those are real rows in someone
 * else's group, and writing them unannounced is the kind of surprise that makes
 * a ledger untrustworthy even when every number is right.
 *
 * Read from the mirror and written through the outbox, so both dialogs work with
 * no network. Only the guest-link panel is online-only.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { planSettleAll, type SettleAllTransfer } from "../../../src/domain/settle.ts";
import {
  ConversionFootnote,
  ConvertBalancesHint,
  EstimatedTotal,
} from "../ConversionNote.tsx";
import { ConvertBalanceDialog } from "../ConvertBalanceDialog.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import {
  applyBalanceDelta,
  cancellingCurrencies,
  SETTLE_ALL_NOTE,
  settleAllHint,
} from "../settleAll.ts";
import { enqueuePayment } from "../recordPayment.ts";
import { LinkPanel } from "../LinkPanel.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { PersonIdentityDialog } from "../PersonIdentityDialog.tsx";
import { OnlineOnly } from "../OnlineOnly.tsx";
import { HelpTip } from "../HelpTip.tsx";
import { PlusIcon } from "../Icons.tsx";
import { Skeleton } from "../Skeleton.tsx";

export function FriendDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const [openDialog, setOpenDialog] = useState<
    "expense" | "settle" | "convert" | "settleAll" | "cascade" | "identity" | null
  >(null);
  // Filled by the settle-up dialog's submit and read by its close, which run
  // back to back in the same tick - so this is a ref, not state. A `useState`
  // here would have the close handler reading the previous render's value and
  // dropping the follow-up question entirely.
  const pendingCascade = useRef<SettleAllTransfer[]>([]);
  const [showSettledGroups, setShowSettledGroups] = useState(false);
  const [settlingAll, setSettlingAll] = useState(false);
  const [filters, setFilters] = useState<ExpenseQuery>({});
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteNotice, setInviteNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(
    null,
  );
  const [linkRevision, setLinkRevision] = useState(0);
  const formatMoney = useFormatMoney();
  const { engine, syncNow, db } = useSync();

  useEffect(() => {
    setFilters({});
    setShowSettledGroups(false);
    setOpenDialog(null);
    pendingCascade.current = [];
    setInviteNotice(null);
    setLinkRevision(0);
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
  // Simplify-debts can leave "Between you" reading zero while a group and the
  // one-on-one bucket still show opposite, cancelling amounts in the same
  // currency. This is the fix for that specific state, not a general settle-up.
  const settleAllTransfers = planSettleAll(user.id, friend.id, friend.breakdown);
  const groupNameForTransfer = (groupId: string | null) =>
    groupId === null ? "One-on-one" : friend.breakdown.find((e) => e.groupId === groupId)?.groupName?.trim() || "Unnamed group";
  const listingGroups = visibleSharedGroups.length > 0 || leftoverGroups.length > 0;
  const showOneOnOne = Boolean(oneOnOne && oneOnOne.balances.length > 0 && listingGroups);
  const showGroupsSection = listingGroups || settledSharedGroups.length > 0;

  const othersOn = (groupId: string) =>
    (membersByGroup.get(groupId) ?? []).filter((m) => m.id !== user.id && m.id !== friend.id);

  // Every no-money-moved payment goes out the same way: the payment, then a
  // comment saying why it exists. Written once so the two dialogs offering it
  // cannot start explaining themselves differently.
  const recordSettleAll = async (transfers: SettleAllTransfer[]) => {
    if (!engine) throw new Error("Not ready to save yet.");
    for (const transfer of transfers) {
      const id = ulid();
      await engine.enqueue({
        kind: "payment.create",
        id,
        payload: paymentAsExpense(transfer, transfer.groupId),
      });
      await engine.enqueue({
        kind: "comment.create",
        id: ulid(),
        payload: { expenseId: id, content: SETTLE_ALL_NOTE },
      });
    }
  };

  const transferList = (transfers: SettleAllTransfer[]) => (
    <div className="ledger">
      {transfers.map((t, i) => (
        <div key={i} className="ledger-row">
          <span className="muted">{groupNameForTransfer(t.groupId)}: </span>
          {nameOf(t.fromUserId)} → {nameOf(t.toUserId)}{" "}
          <Amount minor={t.amountMinor} currency={t.currencyCode} />
        </div>
      ))}
    </div>
  );

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

  const sendInvite = async () => {
    setInviteBusy(true);
    setInviteNotice(null);
    try {
      const result = await api.inviteFriend(friend.id);
      setInviteNotice({
        kind: "ok",
        text: result.emailDelivered
          ? `Invite sent to ${friend.email}.`
          : "No invite was emailed (this server has no mail provider). Copy the guest link below.",
      });
      setLinkRevision((n) => n + 1);
    } catch (err) {
      setInviteNotice({
        kind: "error",
        text: err instanceof Error ? err.message : "Could not send invite",
      });
    } finally {
      setInviteBusy(false);
    }
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
              {friend.is_ghost === 1 && (
                <>
                  {" "}
                  <span className="tag muted">guest</span>
                </>
              )}
            </p>
          </div>
        </div>
        <div className="page-actions">
          {friend.is_ghost === 1 && (
            <OnlineOnly what="Editing a placeholder">
              <button className="secondary" onClick={() => setOpenDialog("identity")}>
                Edit
              </button>
            </OnlineOnly>
          )}
          <button className="secondary" onClick={() => setOpenDialog("settle")}>
            <PlusIcon /> Payment
          </button>
          <button onClick={() => setOpenDialog("expense")}>
            <PlusIcon /> Expense
          </button>
        </div>
      </div>

      {inviteNotice && (
        <p className={inviteNotice.kind === "error" ? "error" : "notice"}>{inviteNotice.text}</p>
      )}

      <AddExpenseDialog
        open={openDialog === "expense"}
        title={`New expense with ${name}`}
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
        title={`New payment with ${name}`}
        people={people}
        currencies={currenciesInPlay}
        choices={friendSettleChoices(owed, user.id, friend.id, name, formatMoney)}
        // The dialog closes itself once onSubmit resolves. If that payment left
        // groups that now cancel out, this is where the follow-up question
        // opens - so the answer is asked for on top of a settled balance the
        // reader can already see, not inside the form that caused it.
        onClose={() => {
          const cascade = pendingCascade.current;
          setOpenDialog(cascade.length > 0 ? "cascade" : null);
        }}
        onSubmit={async (payment) => {
          // A payment is an expense with is_payment set, so the outbox carries
          // it like any other. The pair is spelled out rather than sent as a
          // direction: the queue is a batch of writes, not a set of endpoints,
          // and "you_paid" would need the recipient inferred at replay time.
          await enqueuePayment(engine, payment, null);

          // This settle-up is always one-on-one (groupId null) from this page.
          // If it brings the friend's total for this currency to zero, a shared
          // group can still show the opposite amount. Work out what closing
          // those out would take, but do NOT write it: those payments land in
          // groups with other people in them, so they are offered, not assumed.
          const delta = payment.fromUserId === user.id ? payment.amountMinor : -payment.amountMinor;
          const projected = friend.breakdown.map((entry) =>
            entry.groupId === null
              ? { groupId: entry.groupId, balances: applyBalanceDelta(entry.balances, payment.currencyCode, delta) }
              : entry,
          );
          pendingCascade.current = planSettleAll(user.id, friend.id, projected);
        }}
      />

      {/* The follow-up to a settle-up that zeroed a currency overall. Declining
          is a real answer and leaves the payment just made untouched, which is
          why the other button says so rather than "Cancel". */}
      <ConfirmDialog
        open={openDialog === "cascade"}
        title={`Also settle your groups with ${name}?`}
        confirmLabel="Settle those too"
        cancelLabel="Leave them for now"
        busyLabel="Settling…"
        busy={settlingAll}
        onClose={() => {
          pendingCascade.current = [];
          setOpenDialog(null);
        }}
        onConfirm={async () => {
          setSettlingAll(true);
          try {
            await recordSettleAll(pendingCascade.current);
            pendingCascade.current = [];
            setOpenDialog(null);
          } finally {
            setSettlingAll(false);
          }
        }}
      >
        <p style={{ margin: 0 }}>
          {/* Per currency, like the plan itself: a payment cannot settle a
              debt in a currency it is not denominated in (rule 2). */}
          That payment settles your{" "}
          {cancellingCurrencies(pendingCascade.current).join(" and ")} balance with {name} overall.
          But{" "}
          {pendingCascade.current.length === 1
            ? "one balance below"
            : `${pendingCascade.current.length} balances below`}{" "}
          still {pendingCascade.current.length === 1 ? "reads" : "read"} as unsettled on{" "}
          {pendingCascade.current.length === 1 ? "its" : "their"} own, because{" "}
          {pendingCascade.current.length === 1 ? "it cancels" : "they cancel"} out against what you
          just paid rather than being cleared. Settle{" "}
          {pendingCascade.current.length === 1 ? "it" : "them"} at the same time?
        </p>
        {transferList(pendingCascade.current)}
        <p className="muted" style={{ margin: 0 }}>
          No money moves either way - these are payments recorded to match what is already true.
          Leave them and nothing changes; you can close them out later from this page.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={openDialog === "settleAll"}
        title={`Settle all with ${name}`}
        confirmLabel="Settle all"
        busyLabel="Settling…"
        busy={settlingAll}
        onClose={() => setOpenDialog(null)}
        onConfirm={async () => {
          setSettlingAll(true);
          try {
            await recordSettleAll(settleAllTransfers);
            setOpenDialog(null);
          } finally {
            setSettlingAll(false);
          }
        }}
      >
        <p className="muted" style={{ margin: 0 }}>
          No money moves. Each of these already nets to zero once every group and one-on-one
          balance with {name} in the same currency is added together - this closes them out to
          match.
        </p>
        {transferList(settleAllTransfers)}
      </ConfirmDialog>

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
            {/* The same offer a multi-currency group makes, in the same words:
                several ledgers between two people is the same problem, and
                meeting it phrased differently on the two screens reads like two
                different features. */}
            {/* Both notes share one block, so the card gets one divider rather
                than a stack of rules. Read where the puzzle is: the balance
                just above, not a button under a heading further down. */}
            {(friend.balances.length > 1 || settleAllTransfers.length > 0) && (
              <div className="settle-hints">
                {friend.balances.length > 1 && (
                  <ConvertBalancesHint
                    lead={`${friend.balances.length} currencies to settle separately.`}
                    target={{ code: user.defaultCurrency, label: "your default currency" }}
                    action={
                      <OnlineOnly what="Converting a balance">
                        <button
                          type="button"
                          className="link"
                          onClick={() => setOpenDialog("convert")}
                        >
                          Convert the balances
                        </button>
                      </OnlineOnly>
                    }
                  />
                )}
                {settleAllTransfers.length > 0 && (
                  <p>
                    {settleAllHint(settleAllTransfers)}{" "}
                    <button
                      type="button"
                      className="link"
                      onClick={() => setOpenDialog("settleAll")}
                    >
                      Close them out
                    </button>{" "}
                    to zero them with payments that move no money.
                  </p>
                )}
              </div>
            )}
            <ConversionFootnote
              sets={[friend.balances]}
              preferredCurrency={user.defaultCurrency}
              settingsHref="/settings"
            />
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
                revision={linkRevision}
                extra={
                  <div className="link-slot">
                    {friend.email ? (
                      <div className="link-slot-actions" style={{ marginTop: 0 }}>
                        <OnlineOnly what="Sending an invite">
                          <button
                            type="button"
                            className="secondary inline"
                            disabled={inviteBusy}
                            onClick={() => void sendInvite()}
                          >
                            {inviteBusy ? "Sending…" : "Send invite"}
                          </button>
                        </OnlineOnly>
                        <HelpTip label="About sending the invite">
                          Emails the guest link above to {friend.email}. Each
                          person can be emailed once every 24 hours, and you can
                          send 3 invites per day. If this server has no mail
                          provider, copy the link and send it yourself.
                        </HelpTip>
                      </div>
                    ) : (
                      <p className="muted" style={{ margin: 0 }}>
                        Add an email under Edit to send this link to their inbox.
                      </p>
                    )}
                  </div>
                }
              />
            </>
          )}

          <h2>Shared expenses</h2>
          {/* No person picker: this screen IS "what is between the two of us", and
              the download says so too via csvScope. */}
          <ExpenseFilters
            value={filters}
            onChange={setFilters}
            payers={[{ id: user.id, name: user.name, nickname: user.nickname }, friend]}
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
