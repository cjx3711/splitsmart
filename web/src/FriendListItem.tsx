import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import type { CurrencyAmount } from "./api.ts";
import { Avatar, type AvatarPerson } from "./Avatar.tsx";

/**
 * The group balances panel is a roster, not an outstanding-only ledger: every
 * current member appears, including people at zero. Anyone who left but still
 * has a non-zero position is appended so a leftover debt does not vanish.
 */
export function groupRosterBalances(
  memberIds: string[],
  balances: Array<{ userId: string; balances: CurrencyAmount[] }>,
): Array<{ userId: string; balances: CurrencyAmount[] }> {
  const byUser = new Map(balances.map((e) => [e.userId, e.balances]));
  const seen = new Set<string>();
  const rows: Array<{ userId: string; balances: CurrencyAmount[] }> = [];
  for (const userId of memberIds) {
    seen.add(userId);
    rows.push({ userId, balances: byUser.get(userId) ?? [] });
  }
  for (const entry of balances) {
    if (!seen.has(entry.userId)) rows.push(entry);
  }
  return rows;
}

/** Friend page for everyone except yourself, who has no `/friends/:id`. */
export function friendHref(userId: string, currentUserId: string): string | undefined {
  return userId === currentUserId ? undefined : `/friends/${userId}`;
}

/** "owes" / "gets back" next to a name. First person when the row is you. */
export function ledgerVerb(isYou: boolean, amountMinor: number): string {
  if (amountMinor >= 0) return isYou ? "get back " : "gets back ";
  return isYou ? "owe " : "owes ";
}

export function oweVerb(isYou: boolean): string {
  return isYou ? "owe " : "owes ";
}

/**
 * One person in a list: avatar, name, optional subtitle, optional right slot.
 *
 * When `to` is set the identity is the link (hover included). Interactive
 * `actions` and `extra` (a currency/group dropdown) sit outside that `<a>`
 * so a Remove control or `<details>` is not nested in a link.
 */
export function FriendListItem({
  to,
  avatar,
  title,
  subtitle,
  extra,
  actions,
  children,
}: {
  to?: string;
  avatar: AvatarPerson;
  title: ReactNode;
  subtitle?: ReactNode;
  extra?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const main = (
    <>
      <Avatar {...avatar} />
      <div className="list-item-body">
        <div className="list-item-title">{title}</div>
        {subtitle != null && <div className="list-item-sub">{subtitle}</div>}
        {to ? null : extra}
      </div>
      {children}
    </>
  );

  if (to && (actions || extra)) {
    return (
      <div className="list-item list-item-clickable">
        <Link to={to} className="list-item-main">
          {main}
        </Link>
        {extra != null ? <div className="list-item-extra">{extra}</div> : null}
        {actions != null && <div className="list-item-actions">{actions}</div>}
      </div>
    );
  }

  if (to) {
    return (
      <Link to={to} className="list-item">
        {main}
      </Link>
    );
  }

  return (
    <div className="list-item">
      {main}
      {actions}
    </div>
  );
}
