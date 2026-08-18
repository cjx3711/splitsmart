/**
 * Breadcrumb trails for the guest shell.
 *
 * The shape depends on what the link is, which is why this is not inlined into
 * the two screens that use it:
 *
 *   group / group_member  the bound group IS home. A trail on that screen
 *                         would point at itself, so there isn't one.
 *   friend                home is the you-and-them page, and each of the
 *                         ghost's groups hangs off it.
 *
 * Paths are relative, so react-router resolves them under the `/guest`
 * basename. See Breadcrumbs.tsx.
 */
import { displayName } from "../api.ts";
import type { Crumb } from "../Breadcrumbs.tsx";
import type { GuestSession } from "./guestApi.ts";

/** What the home crumb is called, given what the link is. */
function homeCrumb(session: GuestSession): Crumb | null {
  if (session.kind !== "friend") return null;
  const name = session.counterpart ? displayName(session.counterpart) : "Home";
  return { label: `You and ${name}`, to: "/friend" };
}

export function groupCrumbs(session: GuestSession, groupName: string): Crumb[] {
  const home = homeCrumb(session);
  // A group link opening its own group: no trail, because there is nowhere
  // above it to go.
  if (!home) return [];
  return [home, { label: groupName }];
}

export function expenseCrumbs(
  session: GuestSession,
  expense: { groupId: string | null; groupName: string | null; title: string },
): Crumb[] {
  const home = homeCrumb(session);
  const trail: Crumb[] = [];

  if (home) trail.push(home);

  if (expense.groupId) {
    trail.push({
      label: expense.groupName ?? "Group",
      to: `/groups/${expense.groupId}`,
    });
  }

  trail.push({ label: expense.title });
  return trail;
}

export function seriesCrumbs(
  session: GuestSession,
  expense: {
    expenseId: string;
    groupId: string | null;
    groupName: string | null;
    title: string;
  },
): Crumb[] {
  const trail = expenseCrumbs(session, expense);
  const last = trail[trail.length - 1];
  if (last) last.to = `/expenses/${expense.expenseId}`;
  trail.push({ label: "Series" });
  return trail;
}
