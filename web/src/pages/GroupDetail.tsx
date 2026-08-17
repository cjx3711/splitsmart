/**
 * One group: balances, suggested settle-up, expenses, members, guest links.
 *
 * Everything on the left of the offline/online line in docs/OFFLINE.md is read
 * from the mirror and written through the outbox — the balances and the settle-up
 * suggestions are derived here with the same pure functions the server uses, not
 * fetched. Adding a member and minting a guest link stay online-only, and say so.
 */
import { useState } from "react";
import { useParams } from "react-router-dom";
import { api, fullName, type GroupMember, type ExpenseQuery } from "../api.ts";
import { LinkPanel, type LinkSlot } from "../LinkPanel.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { AddMemberForm } from "../AddMemberForm.tsx";
import { Amount, useFormatMoney } from "../money.tsx";
import { AddExpenseDialog } from "../AddExpenseDialog.tsx";
import { ExpenseList, makeLookup } from "../ExpenseList.tsx";
import { ExpenseFilters } from "../ExpenseFilters.tsx";
import { SettleUpForm } from "../SettleUpForm.tsx";
import { Modal } from "../Modal.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { groupTypeLabel } from "../groupTypes.tsx";
import { Avatar } from "../Avatar.tsx";
import { useAuth } from "../App.tsx";
import { OnlineOnly } from "../OnlineOnly.tsx";
import { useGroupExpenses, useGroupView, useSettleSuggestions } from "../localData.ts";
import { useSync } from "../sync/SyncProvider.tsx";
import { ulid } from "../../../src/domain/ulid.ts";
import { ConversionFootnote, EstimatedTotal } from "../ConversionNote.tsx";

export function GroupDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();

  const [openDialog, setOpenDialog] = useState<"expense" | "settle" | null>(null);
  const [settleCurrency, setSettleCurrency] = useState<string | null>(null);
  const [removingMember, setRemovingMember] = useState<GroupMember | null>(null);
  const [removingBusy, setRemovingBusy] = useState(false);
  const [filters, setFilters] = useState<ExpenseQuery>({});
  const formatMoney = useFormatMoney();
  const { engine, syncNow } = useSync();

  // Live queries: a sync landing, or a queued write, re-renders this screen
  // without anything having to invalidate anything.
  const view = useGroupView(id);
  const expenses = useGroupExpenses(id, filters)?.expenses ?? [];
  const settle = useSettleSuggestions(id)?.suggestions ?? [];

  if (view === undefined || !user) return <p className="muted">Loading…</p>;
  if (view === null) return <p className="empty">This group is not on this device.</p>;

  const { group, members, balances, role } = view;
  const nameOf = makeLookup(members, user.id);
  const people = members.map((m) => ({
    id: m.id,
    label: m.id === user.id ? "You" : fullName(m),
  }));

  // Currencies this group actually holds balances in, with its default first so
  // a group that is fully settled still offers something sensible.
  const currenciesInPlay = [
    ...new Set([
      group.default_currency,
      ...balances.flatMap((b) => b.balances.map((x) => x.currencyCode)),
    ]),
  ];

  // Prefill the settle-up dialog from the largest suggested transfer, so the
  // usual case is one click and a confirm rather than three dropdowns.
  const topTransfer = settle.flatMap((s) =>
    s.transfers.map((t) => ({ ...t, currencyCode: s.currencyCode })),
  )[0];

  const outstandingCurrencies = [
    ...new Set(balances.flatMap((e) => e.balances.map((b) => b.currencyCode))),
  ];
  const showSettlePicker = outstandingCurrencies.length > 1 && settleCurrency === null;
  const activeCurrency = settleCurrency ?? (outstandingCurrencies.length <= 1 ? outstandingCurrencies[0] : null);
  const activeTransfer = activeCurrency
    ? settle.find((s) => s.currencyCode === activeCurrency)?.transfers[0]
    : topTransfer;

  function closeSettle() {
    setOpenDialog(null);
    setSettleCurrency(null);
  }

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
        label: `${fullName(m)} only`,
        note: "Opens straight as them, with no picker.",
      })),
  ];

  return (
    <>
      <Breadcrumbs trail={[{ label: "Groups", to: "/groups" }, { label: group.name }]} />

      <div className="page-head">
        <div>
          <h1>{group.name}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {groupTypeLabel(group.group_type)} · default {group.default_currency} · {members.length}{" "}
            {members.length === 1 ? "member" : "members"}
          </p>
        </div>
        <div className="page-actions">
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

      <Modal
        open={openDialog === "settle"}
        title={`Settle up in ${group.name}`}
        onClose={closeSettle}
      >
        {showSettlePicker ? (
          <div className="settle-currency-picker">
            <p className="muted" style={{ margin: 0 }}>
              Which balance do you want to settle? A payment only clears that currency.
            </p>
            {outstandingCurrencies.map((code) => {
              const transfer = settle.find((s) => s.currencyCode === code)?.transfers[0];
              return (
                <button
                  key={code}
                  type="button"
                  className="secondary"
                  onClick={() => setSettleCurrency(code)}
                >
                  {transfer ? (
                    <>
                      {nameOf(transfer.fromUserId)} → {nameOf(transfer.toUserId)}{" "}
                      <Amount minor={transfer.amountMinor} currency={code} />
                    </>
                  ) : (
                    code
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <SettleUpForm
            className="stack"
            people={people}
            currencies={currenciesInPlay}
            preferredCurrency={user.defaultCurrency}
            initial={
              activeTransfer && activeCurrency
                ? {
                    fromUserId: activeTransfer.fromUserId,
                    toUserId: activeTransfer.toUserId,
                    amount: formatMoney(activeTransfer.amountMinor, activeCurrency) ?? "",
                    currencyCode: activeCurrency,
                  }
                : activeCurrency
                  ? {
                      fromUserId: people[0]?.id ?? "",
                      toUserId: people[1]?.id ?? "",
                      amount: "",
                      currencyCode: activeCurrency,
                    }
                  : topTransfer && {
                      fromUserId: topTransfer.fromUserId,
                      toUserId: topTransfer.toUserId,
                      amount: formatMoney(topTransfer.amountMinor, topTransfer.currencyCode) ?? "",
                      currencyCode: topTransfer.currencyCode,
                    }
            }
            onSubmit={async (payment) => {
              // A payment is an ordinary expense with is_payment set: the payer
              // fronts the whole cost and the recipient owes all of it, which is
              // what cancels an equivalent slice of the balance. Queued like any
              // other write, so settling up works at the table.
              if (!engine) throw new Error("Not ready to save yet.");
              await engine.enqueue({
                kind: "payment.create",
                id: ulid(),
                payload: {
                  groupId: group.id,
                  description: "Payment",
                  costMinor: payment.amountMinor,
                  currencyCode: payment.currencyCode,
                  date: payment.date ?? new Date().toISOString(),
                  splitType: "exact",
                  isPayment: true,
                  participants: [
                    { userId: payment.fromUserId, paidMinor: payment.amountMinor, input: 0 },
                    { userId: payment.toUserId, paidMinor: 0, input: payment.amountMinor },
                  ],
                },
              });
              closeSettle();
            }}
          />
        )}
      </Modal>

      <h2 style={{ marginTop: 0 }}>Balances</h2>
      {balances.length === 0 ? (
        <p className="empty">Everyone is settled up.</p>
      ) : (
        <div className="list">
          {balances.map((entry) => (
            <div key={entry.userId} className="list-item">
              <Avatar id={entry.userId} name={nameOf(entry.userId)} />
              <div className="list-item-body">
                <div className="list-item-title">{nameOf(entry.userId)}</div>
              </div>
              <div>
                <div className="ledger">
                  {entry.balances.map((b) => (
                    <div key={b.currencyCode} className={b.amountMinor >= 0 ? "positive" : "negative"}>
                      {b.amountMinor >= 0 ? "gets back " : "owes "}
                      <Amount minor={b.amountMinor} currency={b.currencyCode} absolute />
                    </div>
                  ))}
                </div>
                <EstimatedTotal balances={entry.balances} preferredCurrency={user.defaultCurrency} />
              </div>
            </div>
          ))}
        </div>
      )}
      <ConversionFootnote
        sets={balances.map((e) => e.balances)}
        preferredCurrency={user.defaultCurrency}
      />

      {settle.some((s) => s.transfers.length > 0) && (
        <>
          <h2>Suggested settle-up</h2>
          <div className="card stack">
            <p className="muted" style={{ margin: 0 }}>
              The fewest transfers that clear this group, one set per currency. Nothing is recorded
              until someone actually pays. Use <strong>Settle up</strong> above, which starts
              prefilled with the first of these.
            </p>
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

      <h2>Expenses</h2>
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

      <h2>Members</h2>
      <div className="list">
        {members.map((m) => (
          <div key={m.id} className="list-item">
            <Avatar id={m.id} name={fullName(m)} />
            <div className="list-item-body">
              <div className="list-item-title">{m.id === user.id ? "You" : fullName(m)}</div>
              <div className="muted">
                {m.role}
                {m.is_ghost === 1 ? " · guest" : " · has an account"}
              </div>
            </div>
            {isOwner && m.id !== user.id && (
              <OnlineOnly what="Removing someone from a group">
                <button
                  className="link"
                  onClick={() => setRemovingMember(m)}
                >
                  Remove
                </button>
              </OnlineOnly>
            )}
          </div>
        ))}
      </div>

      {isOwner && (
        <OnlineOnly what="Adding someone to a group">
          <AddMemberForm
            groupId={group.id}
            existingIds={members.map((m) => m.id)}
            onAdded={syncNow}
          />
        </OnlineOnly>
      )}

      <ConfirmDialog
        open={removingMember !== null}
        title={
          removingMember
            ? `Remove ${fullName(removingMember)} from ${group.name}?`
            : "Remove member?"
        }
        confirmLabel="Remove member"
        busyLabel="Removing…"
        busy={removingBusy}
        onClose={() => setRemovingMember(null)}
        onConfirm={async () => {
          if (!removingMember) return;
          setRemovingBusy(true);
          try {
            await api.removeGroupMember(group.id, removingMember.id);
            syncNow();
            setRemovingMember(null);
          } finally {
            setRemovingBusy(false);
          }
        }}
      >
        <p style={{ margin: 0 }}>
          They will leave this group. Their guest link for this group is turned
          off. Balances and past expenses are unchanged.
        </p>
      </ConfirmDialog>

      <h2>Guest links</h2>
      <LinkPanel
        query={{ groupId: group.id }}
        canManage={isOwner}
        slots={linkSlots}
        intro={
          isOwner
            ? "Guest links expire after 3 months. Anyone holding one can see and edit this group's expenses, so share them carefully. Turn one off or replace it anytime — if a link is compromised, revoke it and create a new one."
            : "Only the group owner can create or turn off guest links."
        }
      />

    </>
  );
}
