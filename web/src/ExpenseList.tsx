/**
 * Expense rows, shared by the group, friend and all-expenses screens.
 *
 * Shows each expense from the signed-in user's point of view: their own net
 * position on it (paid minus owed), which is the number people actually look
 * for. The cost sits next to it for context.
 *
 * Payments (`is_payment`) are a transfer, not a bill, so they get a different
 * row: a small payment mark and "{payer} paid {recipient}" instead of the
 * stored "Payment"/"Settle up" label. The amount is signed (received vs paid)
 * rather than repeating "you lent" / "you borrowed" next to a duplicate total.
 *
 * The row itself opens the expense's own page, where editing and deleting
 * live on the expense's own page, not here, and not behind a bare "✕" with no confirmation. The group
 * and payer names are their own links to that group's or friend's page, so
 * they need `stopPropagation` to keep the row underneath from also navigating.
 */
import { Link, useNavigate } from "react-router-dom";
import { Fragment, type ReactNode } from "react";
import { LuBanknote, LuMessageCircle } from "react-icons/lu";
import { displayName, type ExpenseSummary, type GroupMember } from "./api.ts";
import { Amount } from "./money.tsx";
import { SyncBadge } from "./SyncStatusBar.tsx";
import { PersonLink } from "./PersonLink.tsx";

export interface PersonLookup {
  (userId: string): string;
}

export function makeLookup(
  members: Array<GroupMember | { id: string; name: string; nickname?: string | null }>,
  currentUserId: string,
): PersonLookup {
  const byId = new Map(members.map((m) => [m.id, m]));
  return (userId) => {
    if (userId === currentUserId) return "You";
    const member = byId.get(userId);
    return member ? displayName(member) : `User ${userId}`;
  };
}

type Share = {
  user_id: string;
  paid_share_minor: number;
  owed_share_minor: number;
};

/** The two parties on a settle-up. Payments are always one payer, one recipient. */
export function paymentParties(shares: Share[]): { payer?: Share; recipient?: Share } {
  const payer = shares.find((s) => s.paid_share_minor > 0);
  const recipient = shares.find(
    (s) => s.owed_share_minor > 0 && s.user_id !== payer?.user_id,
  ) ?? shares.find((s) => s.owed_share_minor > 0);
  return { payer, recipient };
}

/** "{You} paid {Poh}" / "{Poh} paid {You}", falling back to "Settle up". */
export function paymentTitle(shares: Share[], nameOf: PersonLookup): string {
  const { payer, recipient } = paymentParties(shares);
  if (!payer || !recipient) return "Settle up";
  return `${nameOf(payer.user_id)} paid ${nameOf(recipient.user_id)}`;
}

export function PaymentMark({ size = 12 }: { size?: number }) {
  return (
    <span className="payment-mark" aria-hidden="true">
      <LuBanknote size={size} />
    </span>
  );
}

export function ExpenseList({
  expenses,
  currentUserId,
  nameOf,
  showGroup = false,
  personLinks = true,
  empty = "Nothing yet.",
  after,
}: {
  expenses: ExpenseSummary[];
  currentUserId: string;
  nameOf: PersonLookup;
  /** Label each row with the group it belongs to. */
  showGroup?: boolean;
  /**
   * Link each payer's name to their friend page. Off in the guest shell, which
   * has no per-person screen: a link to /friends/:id there would be a dead end,
   * and a guest has no friends list to land on in the first place.
   */
  personLinks?: boolean;
  empty?: string;
  /** Extra row(s) rendered inside the list, e.g. an upcoming bill on a series. */
  after?: ReactNode;
}) {
  const navigate = useNavigate();

  if (expenses.length === 0 && !after) return <p className="empty">{empty}</p>;

  return (
    <div className="list">
      {expenses.map((expense) => {
        const mine = expense.shares.find((s) => s.user_id === currentUserId);
        const net = mine ? mine.paid_share_minor - mine.owed_share_minor : 0;
        const payers = expense.shares.filter((s) => s.paid_share_minor > 0);
        const isPayment = expense.is_payment === 1;
        const { payer, recipient } = isPayment ? paymentParties(expense.shares) : {};
        const comments = expense.comment_count ?? 0;

        return (
          <div
            key={expense.id}
            className={`list-item${isPayment ? " list-item-payment" : ""}`}
            role="link"
            tabIndex={0}
            style={{ cursor: "pointer" }}
            onClick={() => navigate(`/expenses/${expense.id}`)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(`/expenses/${expense.id}`);
            }}
          >
            {isPayment && <PaymentMark />}
            <div className="list-item-body">
              <div className="list-item-title">
                {isPayment ? (
                  payer && recipient ? (
                    <>
                      <PersonName
                        userId={payer.user_id}
                        currentUserId={currentUserId}
                        nameOf={nameOf}
                        personLinks={personLinks}
                      />{" "}
                      paid{" "}
                      <PersonName
                        userId={recipient.user_id}
                        currentUserId={currentUserId}
                        nameOf={nameOf}
                        personLinks={personLinks}
                      />
                    </>
                  ) : (
                    "Settle up"
                  )
                ) : (
                  expense.description
                )}
                <SyncBadge state={expense.syncState} />
              </div>
              <div className="muted">
                {expense.date.slice(0, 10)}
                {showGroup && expense.group_id && (
                  <>
                    {" · "}
                    <Link to={`/groups/${expense.group_id}`} onClick={(e) => e.stopPropagation()}>
                      {expense.group_name}
                    </Link>
                  </>
                )}
                {!isPayment && expense.category_name && ` · ${expense.category_name}`}
                {!isPayment && payers.length > 0 && (
                  <>
                    {" · "}
                    {payers.map((p, i) => (
                      <Fragment key={p.user_id}>
                        {i > 0 && ", "}
                        <PersonName
                          userId={p.user_id}
                          currentUserId={currentUserId}
                          nameOf={nameOf}
                          personLinks={personLinks}
                        />
                      </Fragment>
                    ))}{" "}
                    paid
                  </>
                )}
                {comments > 0 && (
                  <>
                    {" · "}
                    <span className="list-item-comments">
                      {comments}
                      <LuMessageCircle size={12} aria-hidden="true" />
                      <span className="sr-only">
                        {comments === 1 ? " comment" : " comments"}
                      </span>
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="list-item-figures">
              <div>
                {/* A series template and one of its bills look the same in a list
                    otherwise, and editing the wrong one has different consequences. */}
                {expense.repeat_interval && (
                  <span className="tag" title={`Repeats ${expense.repeat_interval}`}>
                    repeats
                  </span>
                )}
                {!expense.repeat_interval && expense.repeat_of && (
                  <span className="tag muted" title="One of a repeating series">
                    series
                  </span>
                )}
                {expense.deleted_at && (
                  <span className="tag muted" title="Deleted. Open it to undo.">
                    deleted
                  </span>
                )}
                {isPayment ? (
                  <Amount
                    minor={net !== 0 ? net : expense.cost_minor}
                    currency={expense.currency_code}
                    absolute
                    signed={net !== 0}
                  />
                ) : (
                  <Amount minor={expense.cost_minor} currency={expense.currency_code} />
                )}
              </div>
              {!isPayment && net !== 0 && (
                <div className="muted list-item-caption">
                  {net > 0 ? "you lent " : "you borrowed "}
                  <Amount minor={net} currency={expense.currency_code} absolute />
                </div>
              )}
            </div>
          </div>
        );
      })}
      {after}
    </div>
  );
}

function PersonName({
  userId,
  currentUserId,
  nameOf,
  personLinks,
}: {
  userId: string;
  currentUserId: string;
  nameOf: PersonLookup;
  personLinks: boolean;
}) {
  const name = nameOf(userId);
  if (userId === currentUserId || !personLinks) return <>{name}</>;
  return (
    <PersonLink
      userId={userId}
      currentUserId={currentUserId}
      onClick={(e) => e.stopPropagation()}
    >
      {name}
    </PersonLink>
  );
}
