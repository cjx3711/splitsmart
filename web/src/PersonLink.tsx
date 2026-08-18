import { Link } from "react-router-dom";
import type { MouseEvent, ReactNode } from "react";

/** A person's name, linked to their friend page unless it is you. */
export function PersonLink({
  userId,
  currentUserId,
  children,
  onClick,
}: {
  userId: string;
  currentUserId: string;
  children: ReactNode;
  onClick?: (e: MouseEvent) => void;
}) {
  if (userId === currentUserId) return <>{children}</>;
  return (
    <Link to={`/friends/${userId}`} className="person-link" onClick={onClick}>
      {children}
    </Link>
  );
}
