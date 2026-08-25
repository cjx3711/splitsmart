/**
 * Friends the owner has crossed off the sidebar.
 *
 * Local to this browser (`splitsmart:<userId>:hidden-friends`). The rail is
 * a shortcut, not the roster: hiding someone here does not remove a
 * friendship, and the Friends page still lists them.
 *
 * A hide is a snapshot of their latest shared expense. They stay off the
 * rail until that id moves (a new bill with them) or the filter box is
 * in use — searching is how you find someone you put away.
 */
const HIDDEN_FRIENDS_VERSION = 1;

export type HiddenFriendsMap = Record<string, string>;

interface HiddenFriendsCache {
  v: typeof HIDDEN_FRIENDS_VERSION;
  /** friendId → newest shared expense id (or "") at the moment they were hidden. */
  at: HiddenFriendsMap;
}

export function hiddenFriendsKey(userId: string): string {
  return `splitsmart:${userId}:hidden-friends`;
}

export function loadHiddenFriends(userId: string): HiddenFriendsMap {
  try {
    const raw = localStorage.getItem(hiddenFriendsKey(userId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as HiddenFriendsCache;
    if (parsed.v !== HIDDEN_FRIENDS_VERSION || !parsed.at) return {};
    return parsed.at;
  } catch {
    return {};
  }
}

export function saveHiddenFriends(userId: string, at: HiddenFriendsMap): void {
  try {
    const cache: HiddenFriendsCache = { v: HIDDEN_FRIENDS_VERSION, at };
    localStorage.setItem(hiddenFriendsKey(userId), JSON.stringify(cache));
  } catch {
    // private mode / quota — the hide still applies for this session
  }
}

export function hideFriend(
  hidden: HiddenFriendsMap,
  friendId: string,
  lastExpenseId: string,
): HiddenFriendsMap {
  return { ...hidden, [friendId]: lastExpenseId };
}

/**
 * Whether the rail should omit this friend.
 *
 * Search always shows them. A last-expense id newer than the snapshot is
 * new activity and brings them back; ULIDs compare as strings.
 */
export function friendIsHidden(
  hiddenAt: string | undefined,
  lastExpenseId: string,
  searching: boolean,
): boolean {
  if (searching || hiddenAt === undefined) return false;
  return lastExpenseId <= hiddenAt;
}
