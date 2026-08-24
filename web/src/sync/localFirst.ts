/**
 * Write-through for edits that are not outbox ops.
 *
 * Expenses and comments go through `engine.enqueue`, which applies locally in
 * the same transaction as the queue row. Everything else here - names, the
 * simplify-debts flag, leaving a group, unfriending - is still a live HTTP
 * call (docs/OFFLINE.md: the server mints user and group identities), but the
 * mirror is updated first so liveQuery screens flip immediately, and reverted
 * if the server refuses.
 *
 * Creates that must stay online (new group, new friend, new member) write the
 * returned entity into Dexie as soon as the response lands, so the next page
 * does not wait on a pull.
 */
import {
  dropFriendship,
  putFriendships,
  putGroupMembers,
  putGroups,
} from "../db/apply.ts";
import { friendshipKey, getMeta, memberKey, setMeta, type LocalDb } from "../db/local.ts";
import type { SyncFriendship, SyncGroup, SyncGroupMember, SyncUser } from "../db/local.ts";
import { parseAvatarPattern, type AvatarPattern } from "../../../src/domain/avatar-pattern.ts";

export type IdentityPatch = {
  name?: string;
  nickname?: string | null;
  iconLetters?: string | null;
  iconEmoji?: string | null;
  iconHue?: number | null;
  iconPattern?: AvatarPattern | null;
  defaultCurrency?: string;
};

function withIdentity(user: SyncUser, patch: IdentityPatch): SyncUser {
  return {
    ...user,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.nickname !== undefined ? { nickname: patch.nickname } : {}),
    ...(patch.iconLetters !== undefined ? { iconLetters: patch.iconLetters } : {}),
    ...(patch.iconEmoji !== undefined ? { iconEmoji: patch.iconEmoji } : {}),
    ...(patch.iconHue !== undefined ? { iconHue: patch.iconHue } : {}),
    ...(patch.iconPattern !== undefined ? { iconPattern: patch.iconPattern } : {}),
    ...(patch.defaultCurrency !== undefined ? { defaultCurrency: patch.defaultCurrency } : {}),
  };
}

/**
 * Patches a person everywhere they are stored: the users row, nested copies on
 * memberships / friendships / expenses / comments, and the cached profile if
 * this is you. Returns the previous users row so the caller can revert.
 */
export async function patchPerson(
  db: LocalDb,
  userId: string,
  patch: IdentityPatch,
): Promise<SyncUser | undefined> {
  const previous = await db.users.get(userId);
  if (!previous) return undefined;

  const next = withIdentity(previous, patch);
  await db.users.put(next);

  const members = await db.groupMembers.toArray();
  const memberUpdates = members
    .filter((m) => m.userId === userId || m.user?.id === userId)
    .map((m) => ({
      ...m,
      user: m.user ? withIdentity(m.user, patch) : next,
    }));
  if (memberUpdates.length > 0) await db.groupMembers.bulkPut(memberUpdates);

  const friendships = await db.friendships.toArray();
  const friendUpdates = friendships
    .filter((f) => f.otherUser?.id === userId)
    .map((f) => ({
      ...f,
      otherUser: f.otherUser ? withIdentity(f.otherUser, patch) : f.otherUser,
    }));
  if (friendUpdates.length > 0) await db.friendships.bulkPut(friendUpdates);

  const expenses = await db.expenses.toArray();
  const expenseUpdates = expenses.filter((e) => e.people.some((p) => p.id === userId));
  if (expenseUpdates.length > 0) {
    await db.expenses.bulkPut(
      expenseUpdates.map((e) => ({
        ...e,
        people: e.people.map((p) => (p.id === userId ? withIdentity(p, patch) : p)),
      })),
    );
  }

  const comments = await db.comments.toArray();
  const commentUpdates = comments.filter((c) => c.author?.id === userId || c.userId === userId);
  if (commentUpdates.length > 0) {
    await db.comments.bulkPut(
      commentUpdates.map((c) => ({
        ...c,
        author: c.author?.id === userId ? withIdentity(c.author, patch) : c.author,
      })),
    );
  }

  const profile = await getMeta(db, "profile");
  if (profile?.id === userId) await setMeta(db, "profile", withIdentity(profile, patch));

  return previous;
}

export async function revertPerson(db: LocalDb, previous: SyncUser): Promise<void> {
  await patchPerson(db, previous.id, {
    name: previous.name,
    nickname: previous.nickname,
    iconLetters: previous.iconLetters,
    iconEmoji: previous.iconEmoji,
    iconHue: previous.iconHue,
    iconPattern: previous.iconPattern,
    defaultCurrency: previous.defaultCurrency,
  });
}

export async function setGroupSimplify(
  db: LocalDb,
  groupId: string,
  on: boolean,
): Promise<boolean | undefined> {
  const group = await db.groups.get(groupId);
  if (!group) return undefined;
  const was = group.simplifyByDefault !== false;
  await db.groups.update(groupId, { simplifyByDefault: on });
  return was;
}

export async function markMemberLeft(
  db: LocalDb,
  groupId: string,
  userId: string,
): Promise<SyncGroupMember | undefined> {
  const existing = await db.groupMembers.get(memberKey(groupId, userId));
  if (!existing) return undefined;
  await db.groupMembers.put({ ...existing, leftAt: new Date().toISOString() });
  return existing;
}

export async function restoreMember(db: LocalDb, member: SyncGroupMember): Promise<void> {
  await putGroupMembers(db, [member]);
}

function canonicalPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export async function dropFriendPair(
  db: LocalDb,
  selfId: string,
  otherId: string,
): Promise<SyncFriendship | undefined> {
  const [userAId, userBId] = canonicalPair(selfId, otherId);
  const existing = await db.friendships.get(friendshipKey(userAId, userBId));
  await dropFriendship(db, userAId, userBId);
  return existing;
}

export async function restoreFriendPair(db: LocalDb, row: SyncFriendship): Promise<void> {
  await putFriendships(db, [row]);
}

type WirePerson = {
  id: string;
  name: string;
  nickname?: string | null;
  email?: string | null;
  icon_letters?: string | null;
  icon_emoji?: string | null;
  icon_hue?: number | null;
  icon_pattern?: unknown;
  iconLetters?: string | null;
  iconEmoji?: string | null;
  iconHue?: number | null;
  iconPattern?: unknown;
  is_ghost?: number;
  isGhost?: boolean;
  default_currency?: string;
  defaultCurrency?: string;
};

export function syncUserFromWire(person: WirePerson, fallbackCurrency: string): SyncUser {
  return {
    id: person.id,
    name: person.name,
    nickname: person.nickname ?? null,
    iconLetters: person.iconLetters ?? person.icon_letters ?? null,
    iconEmoji: person.iconEmoji ?? person.icon_emoji ?? null,
    iconHue: person.iconHue ?? person.icon_hue ?? null,
    iconPattern: parseAvatarPattern(person.iconPattern ?? person.icon_pattern),
    email: person.email ?? null,
    isGhost: person.isGhost === true || person.is_ghost === 1,
    defaultCurrency: person.defaultCurrency ?? person.default_currency ?? fallbackCurrency,
    mergedIntoUserId: null,
    deletedAt: null,
  };
}

type WireGroup = {
  id: string;
  name: string;
  group_type?: string;
  groupType?: string;
  default_currency?: string;
  defaultCurrency?: string;
  simplify_by_default?: number | boolean;
  simplifyByDefault?: boolean;
};

export async function ingestCreatedGroup(
  db: LocalDb,
  group: WireGroup,
  self: SyncUser,
): Promise<void> {
  const simplify =
    group.simplifyByDefault ??
    (group.simplify_by_default === undefined ? true : Boolean(group.simplify_by_default));
  const syncGroup: SyncGroup = {
    id: group.id,
    name: group.name,
    groupType: group.groupType ?? group.group_type ?? "other",
    defaultCurrency: group.defaultCurrency ?? group.default_currency ?? self.defaultCurrency,
    simplifyByDefault: simplify !== false,
    createdBy: self.id,
    deletedAt: null,
  };
  await putGroups(db, [syncGroup]);
  await putGroupMembers(db, [
    {
      groupId: group.id,
      userId: self.id,
      role: "owner",
      joinedVia: "creator",
      joinedAt: new Date().toISOString(),
      leftAt: null,
      user: self,
    },
  ]);
}

export async function ingestCreatedFriend(
  db: LocalDb,
  selfId: string,
  friend: WirePerson,
  fallbackCurrency: string,
): Promise<void> {
  const user = syncUserFromWire(friend, fallbackCurrency);
  const [userAId, userBId] = canonicalPair(selfId, friend.id);
  await putFriendships(db, [
    {
      userAId,
      userBId,
      createdAt: new Date().toISOString(),
      otherUser: user,
    },
  ]);
}

type WireMember = WirePerson & {
  role?: string;
  joined_via?: string;
  joinedVia?: string;
};

export async function ingestAddedMember(
  db: LocalDb,
  groupId: string,
  member: WireMember,
): Promise<void> {
  const group = await db.groups.get(groupId);
  const existing = await db.users.get(member.id);
  const user = existing ?? syncUserFromWire(member, group?.defaultCurrency ?? "USD");
  await putGroupMembers(db, [
    {
      groupId,
      userId: member.id,
      role: member.role ?? "member",
      joinedVia: member.joinedVia ?? member.joined_via ?? "added",
      joinedAt: new Date().toISOString(),
      leftAt: null,
      user,
    },
  ]);
}

export async function selfAsSyncUser(db: LocalDb, fallback: SyncUser): Promise<SyncUser> {
  return (await db.users.get(fallback.id)) ?? (await getMeta(db, "profile")) ?? fallback;
}

/** The signed-in profile as a SyncUser, for ingesting a group we just created. */
export function syncUserFromApiUser(user: {
  id: string;
  name: string;
  nickname?: string | null;
  email?: string | null;
  iconLetters?: string | null;
  iconEmoji?: string | null;
  iconHue?: number | null;
  iconPattern?: AvatarPattern | null;
  isGhost?: boolean;
  defaultCurrency: string;
}): SyncUser {
  return {
    id: user.id,
    name: user.name,
    nickname: user.nickname ?? null,
    iconLetters: user.iconLetters ?? null,
    iconEmoji: user.iconEmoji ?? null,
    iconHue: user.iconHue ?? null,
    iconPattern: user.iconPattern ?? null,
    email: user.email ?? null,
    isGhost: Boolean(user.isGhost),
    defaultCurrency: user.defaultCurrency,
    mergedIntoUserId: null,
    deletedAt: null,
  };
}
