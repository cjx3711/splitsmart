import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { Avatar, type AvatarPerson } from "./Avatar.tsx";

/** Friend page for everyone except yourself, who has no `/friends/:id`. */
export function friendHref(userId: string, currentUserId: string): string | undefined {
  return userId === currentUserId ? undefined : `/friends/${userId}`;
}

/**
 * One person in a list: avatar, name, optional subtitle, optional right slot.
 *
 * When `to` is set the whole row is the link (hover included). Interactive
 * `actions` sit beside that link so a Remove/Edit control is not nested in
 * an `<a>`.
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
        {extra}
      </div>
      {children}
    </>
  );

  if (to && actions) {
    return (
      <div className="list-item list-item-clickable">
        <Link to={to} className="list-item-main">
          {main}
        </Link>
        <div className="list-item-actions">{actions}</div>
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
