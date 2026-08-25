/**
 * Guest access links: mint, resolve, revoke, and scope.
 *
 * THE URL IS THE CREDENTIAL. A guest has no account, no cookie and no session
 * row. They hold a secret; this module says what that secret may see and do,
 * and it is asked again on every single request. That is the whole reason
 * revocation is instant and the guest app is never allowed to work offline: a
 * link can be taken away, a local copy cannot.
 *
 * See docs/GUEST.md for the model. The rules that live here rather than in the
 * schema, because they span tables:
 *
 *   - a link may only ever act as an UNCLAIMED GHOST. The moment someone claims
 *     that person (is_ghost = 0, or merged and soft-deleted) every link
 *     pointing at them stops resolving, with a message that says to log in
 *     rather than "invalid link".
 *   - a `group` link acts as whoever the holder picks, re-pickably, but only
 *     among that group's live ghost members.
 *   - a `friend` link is the wide one: the owner's 1:1 expenses with that
 *     ghost, plus every group the ghost belongs to. It is NOT "everything the
 *     owner can see": the owner's other friends and groups stay invisible.
 */
import type { DB } from "../db/index.ts";
import { db } from "../db/index.ts";
import { env } from "../env.ts";
import { generateToken, hashToken } from "../auth/password.ts";
import { ulid } from "./ulid.ts";
import { personCamel, type AvatarPattern } from "./person.ts";

export type LinkKind = "group" | "group_member" | "friend";

export const LINK_KINDS: readonly LinkKind[] = ["group", "group_member", "friend"];

/** Every guest link expires; this is also the longest expiry an owner may set. */
export const LINK_TTL_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/** Default expiry for a newly minted link: 3 months from now. */
export function defaultLinkExpiry(from = new Date()): string {
  return new Date(from.getTime() + LINK_TTL_DAYS * MS_PER_DAY).toISOString();
}

/**
 * Picks the expiry for a new link.
 *
 * Absent means the default (3 months). A requested time is honoured only if it
 * is sooner than that cap - owners cannot mint a link that outlives the max.
 */
export function resolveLinkExpiry(expiresAt?: string | null, from = new Date()): string {
  const cap = new Date(from.getTime() + LINK_TTL_DAYS * MS_PER_DAY);
  if (!expiresAt) return cap.toISOString();
  const requested = new Date(expiresAt);
  return requested < cap ? requested.toISOString() : cap.toISOString();
}

/**
 * Bearer prefix that marks a guest secret.
 *
 * Load-bearing: `requireAuth` on the logged-in tree looks for this and refuses
 * outright, so a link can never be presented as a full-user credential to
 * /api/v1. See src/auth/middleware.ts.
 */
export const LINK_TOKEN_PREFIX = "link_";

export function isLinkToken(value: string): boolean {
  return value.startsWith(LINK_TOKEN_PREFIX);
}

/** Strips the prefix. The stored hash is of the secret WITHOUT it. */
function secretOf(bearer: string): string {
  return bearer.startsWith(LINK_TOKEN_PREFIX)
    ? bearer.slice(LINK_TOKEN_PREFIX.length)
    : bearer;
}

export function guestUrl(secret: string): string {
  return `${env.APP_ORIGIN}/guest/l/${secret}`;
}

export interface AccessLinkRecord {
  id: string;
  kind: LinkKind;
  groupId: string | null;
  /** The ghost this link acts as. NULL only for kind = 'group'. */
  userId: string | null;
  /** The account that minted it: the owner, and for `friend` links the far side. */
  createdBy: string;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export type LinkFailure =
  | "invalid"
  | "expired"
  | "revoked"
  | "claimed"
  | "gone";

export class AccessLinkError extends Error {}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

export interface MintInput {
  kind: LinkKind;
  groupId?: string | null;
  userId?: string | null;
  createdBy: string;
  /** ISO-8601. Absent means the default (3 months). Capped at LINK_TTL_DAYS. */
  expiresAt?: string | null;
}

/**
 * Mints a link, revoking whatever live link already occupied the same slot.
 *
 * There is at most one live link per (group), (group, member) or (owner,
 * friend) - the schema enforces it with partial unique indexes - so minting is
 * also how you rotate: the old secret dies at the same instant the new one is
 * born, and no window exists where both work.
 *
 * The plaintext secret is stored so the owner can copy the link again later.
 * Guest auth still resolves via token_hash.
 */
export async function mintAccessLink(
  trx: DB,
  input: MintInput,
): Promise<{ id: string; secret: string; url: string }> {
  const kind = input.kind;
  const groupId = input.groupId ?? null;
  const userId = input.userId ?? null;

  if (kind === "group" && (groupId === null || userId !== null)) {
    throw new AccessLinkError("A group link needs a group and no person");
  }
  if (kind === "group_member" && (groupId === null || userId === null)) {
    throw new AccessLinkError("A member link needs both a group and a person");
  }
  if (kind === "friend" && (groupId !== null || userId === null)) {
    throw new AccessLinkError("A friend link names a person and no group");
  }

  if (userId !== null) {
    const target = await trx
      .selectFrom("users")
      .select(["is_ghost", "deleted_at"])
      .where("id", "=", userId)
      .executeTakeFirst();

    if (!target || target.deleted_at) {
      throw new AccessLinkError("That person no longer exists");
    }
    // Minting a link that could never resolve is a worse failure than
    // refusing here: the owner would copy a URL that 401s on first use.
    if (target.is_ghost !== 1) {
      throw new AccessLinkError("That person has their own account; they log in instead");
    }
  }

  await revokeSlot(trx, kind, groupId, userId, input.createdBy);

  const secret = generateToken(64);
  const id = ulid();

  const expiresAt = resolveLinkExpiry(input.expiresAt);

  await trx
    .insertInto("access_links")
    .values({
      id,
      token_hash: hashToken(secret),
      token_secret: secret,
      kind,
      group_id: groupId,
      user_id: userId,
      created_by: input.createdBy,
      expires_at: expiresAt,
    })
    .execute();

  return { id, secret, url: guestUrl(secret) };
}

/** Revokes the live link occupying a slot, if any. Rotation depends on this. */
async function revokeSlot(
  trx: DB,
  kind: LinkKind,
  groupId: string | null,
  userId: string | null,
  createdBy: string,
): Promise<void> {
  let query = trx
    .updateTable("access_links")
    .set({ revoked_at: new Date().toISOString() })
    .where("kind", "=", kind)
    .where("revoked_at", "is", null);

  if (kind === "friend") {
    query = query.where("created_by", "=", createdBy).where("user_id", "=", userId);
  } else {
    query = query.where("group_id", "=", groupId);
    if (kind === "group_member") query = query.where("user_id", "=", userId);
    else query = query.where("user_id", "is", null);
  }

  await query.execute();
}

// ---------------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------------

/**
 * Turns the secret on the wire into a scope, or into a reason it failed.
 *
 * The failure reasons are distinguished on purpose: "this person has an account
 * now, log in" and "ask whoever shared this for a new link" are different
 * instructions, and a guest who is told the wrong one gives up.
 */
export async function resolveAccessLink(
  bearer: string,
): Promise<{ ok: true; link: AccessLinkRecord } | { ok: false; reason: LinkFailure }> {
  const secret = secretOf(bearer.trim());
  if (!secret) return { ok: false, reason: "invalid" };

  const row = await db
    .selectFrom("access_links")
    .select([
      "id",
      "kind",
      "group_id",
      "user_id",
      "created_by",
      "expires_at",
      "revoked_at",
      "created_at",
      "last_used_at",
    ])
    .where("token_hash", "=", hashToken(secret))
    .executeTakeFirst();

  if (!row) return { ok: false, reason: "invalid" };
  if (row.revoked_at) return { ok: false, reason: "revoked" };
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return { ok: false, reason: "expired" };
  }

  if (row.group_id) {
    const group = await db
      .selectFrom("groups")
      .select("id")
      .where("id", "=", row.group_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!group) return { ok: false, reason: "gone" };
  }

  if (row.user_id) {
    const target = await db
      .selectFrom("users")
      .select(["is_ghost", "deleted_at"])
      .where("id", "=", row.user_id)
      .executeTakeFirst();
    if (!target || target.deleted_at) return { ok: false, reason: "claimed" };
    // Claimed in place, without a merge. Still "they have an account now".
    if (target.is_ghost !== 1) return { ok: false, reason: "claimed" };
  }

  // Best-effort; never block the request on it.
  void db
    .updateTable("access_links")
    .set({ last_used_at: new Date().toISOString() })
    .where("id", "=", row.id)
    .execute()
    .catch(() => {});

  return {
    ok: true,
    link: {
      id: row.id,
      kind: row.kind as LinkKind,
      groupId: row.group_id,
      userId: row.user_id,
      createdBy: row.created_by,
      expiresAt: row.expires_at,
      revokedAt: null,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
    },
  };
}

function toLinkRecord(row: {
  id: string;
  kind: string;
  group_id: string | null;
  user_id: string | null;
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
}): AccessLinkRecord {
  return {
    id: row.id,
    kind: row.kind as LinkKind,
    groupId: row.group_id,
    userId: row.user_id,
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/**
 * Claim-page resolution. Guest `resolveAccessLink` is unchanged: a dead
 * friend link still 401s for everyone, including the claimer.
 *
 * Here the caller is logged in, so we can tell the survivor from a
 * stranger. After a merge the bound links are revoked; the person who
 * absorbed the ghost still sees `already_claimed` (the success screen).
 * Anyone else gets `invalid` — not "claimed", not "turned off" — so the
 * URL does not confirm that a real account now sits behind it.
 */
export type ClaimLinkInspection =
  | { status: "live"; link: AccessLinkRecord }
  | { status: "already_claimed"; link: AccessLinkRecord }
  | { status: "failed"; reason: LinkFailure };

export async function inspectClaimLink(
  bearer: string,
  authUserId: string,
): Promise<ClaimLinkInspection> {
  const secret = secretOf(bearer.trim());
  if (!secret) return { status: "failed", reason: "invalid" };

  const row = await db
    .selectFrom("access_links")
    .select([
      "id",
      "kind",
      "group_id",
      "user_id",
      "created_by",
      "expires_at",
      "revoked_at",
      "created_at",
      "last_used_at",
    ])
    .where("token_hash", "=", hashToken(secret))
    .executeTakeFirst();

  if (!row) return { status: "failed", reason: "invalid" };

  if (row.user_id) {
    const target = await db
      .selectFrom("users")
      .select(["id", "is_ghost", "deleted_at", "merged_into_user_id"])
      .where("id", "=", row.user_id)
      .executeTakeFirst();
    const boundGone = !target || target.deleted_at !== null || target.is_ghost !== 1;
    const yours =
      target?.merged_into_user_id === authUserId ||
      (target != null && target.is_ghost !== 1 && target.deleted_at === null && target.id === authUserId);
    if (row.revoked_at || boundGone) {
      return yours
        ? { status: "already_claimed", link: toLinkRecord(row) }
        : { status: "failed", reason: "invalid" };
    }
  } else if (row.revoked_at) {
    return { status: "failed", reason: "revoked" };
  }

  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    return { status: "failed", reason: "expired" };
  }

  if (row.group_id) {
    const group = await db
      .selectFrom("groups")
      .select("id")
      .where("id", "=", row.group_id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!group) return { status: "failed", reason: "gone" };
  }

  return { status: "live", link: toLinkRecord(row) };
}

export function failureMessage(reason: LinkFailure): string {
  switch (reason) {
    case "claimed":
      return "This person has an account now. Log in instead.";
    case "expired":
      return "This link has expired. Ask whoever shared it for a new one.";
    case "revoked":
      return "This link has been turned off. Ask whoever shared it for a new one.";
    case "gone":
      return "Whatever this link pointed at is gone.";
    default:
      return "This link is not valid. Ask whoever shared it for a new one.";
  }
}

// ---------------------------------------------------------------------------
// Who the holder is acting as
// ---------------------------------------------------------------------------

export interface ActablePerson {
  id: string;
  name: string;
  nickname: string | null;
  iconLetters: string | null;
  iconEmoji: string | null;
  iconHue: number | null;
  iconPattern: AvatarPattern | null;
}

/**
 * The names a general group link may act as.
 *
 * Ghosts only. Someone with a real account is not impersonable by a shared
 * secret; the picker leaves them out and the resolver would refuse them anyway.
 */
export async function listActablePeople(
  database: DB,
  link: AccessLinkRecord,
): Promise<ActablePerson[]> {
  if (link.kind !== "group") {
    if (!link.userId) return [];
    const one = await database
      .selectFrom("users")
      .select(["id", "name", "nickname", "icon_letters", "icon_emoji", "icon_hue", "icon_pattern"])
      .where("id", "=", link.userId)
      .where("is_ghost", "=", 1)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return one ? [{ id: one.id, ...personCamel(one) }] : [];
  }

  const rows = await database
    .selectFrom("group_members")
    .innerJoin("users", "users.id", "group_members.user_id")
    .select(["users.id", "users.name", "users.nickname", "users.icon_letters", "users.icon_emoji", "users.icon_hue", "users.icon_pattern"])
    .where("group_members.group_id", "=", link.groupId!)
    .where("group_members.left_at", "is", null)
    .where("users.is_ghost", "=", 1)
    .where("users.deleted_at", "is", null)
    .orderBy("users.name")
    .orderBy("users.id")
    .execute();

  return rows.map((r) => ({ id: r.id, ...personCamel(r) }));
}

/**
 * Settles who this request is acting as.
 *
 * For `group_member` and `friend` the answer is fixed by the link itself and
 * any client-supplied preference is ignored. For a general `group` link the
 * holder picks, and the pick arrives on every request (there is no server-side
 * guest state to remember it in), so it is re-validated every time.
 */
export async function resolveActingAs(
  database: DB,
  link: AccessLinkRecord,
  requested: string | undefined,
): Promise<{ ok: true; userId: string } | { ok: false; error: string }> {
  if (link.kind !== "group") {
    return { ok: true, userId: link.userId! };
  }

  if (!requested) return { ok: false, error: "Pick who you are in this group first." };

  const actable = await listActablePeople(database, link);
  if (!actable.some((p) => p.id === requested)) {
    return {
      ok: false,
      error: "That name is not one this link can use. Pick again.",
    };
  }

  return { ok: true, userId: requested };
}

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

/**
 * Every group this link may read, as that person.
 *
 * A group or group_member link is exactly one group. A friend link is every
 * group the ghost belongs to; the owner minted a link for this person, and this
 * person's groups are what that person can see.
 */
export async function linkGroupIds(
  database: DB,
  link: AccessLinkRecord,
  actingAs: string,
): Promise<string[]> {
  if (link.kind !== "friend") return [link.groupId!];

  const rows = await database
    .selectFrom("group_members")
    .innerJoin("groups", "groups.id", "group_members.group_id")
    .select("group_members.group_id")
    .where("group_members.user_id", "=", actingAs)
    .where("group_members.left_at", "is", null)
    .where("groups.deleted_at", "is", null)
    .execute();

  return rows.map((r) => r.group_id);
}

export interface GuestScope {
  link: AccessLinkRecord;
  /** The ghost this request speaks as. */
  actingAs: string;
  /** Groups readable through this link. */
  groupIds: string[];
  /**
   * The far side of a `friend` link: the owner who minted it. Non-group
   * expenses are visible only when BOTH this person and the guest are on them.
   * Null for group links, which have no 1:1 surface at all.
   */
  counterpartId: string | null;
}

export async function buildScope(
  database: DB,
  link: AccessLinkRecord,
  actingAs: string,
): Promise<GuestScope> {
  return {
    link,
    actingAs,
    groupIds: await linkGroupIds(database, link, actingAs),
    counterpartId: link.kind === "friend" ? link.createdBy : null,
  };
}

/**
 * Whether an expense is inside the scope.
 *
 * Two ways in, and no third:
 *
 *   1. it belongs to a group the link covers — every bill in that group,
 *      whether the guest is named on it or not, so a member can edit anyone's
 *      expense the way a logged-in member can;
 *   2. it belongs to no group, and BOTH the guest and the friend link's owner
 *      are on it.
 *
 * Rule 2 is why a group link never sees a 1:1 expense: `counterpartId` is null,
 * so the branch cannot be taken. That is the specific leak this function
 * exists to prevent.
 */
export function expenseInScope(
  scope: GuestScope,
  expense: { groupId: string | null; participantIds: string[] },
): boolean {
  if (expense.groupId !== null) return scope.groupIds.includes(expense.groupId);

  return (
    scope.counterpartId !== null &&
    expense.participantIds.includes(scope.actingAs) &&
    expense.participantIds.includes(scope.counterpartId)
  );
}

/**
 * Who may appear on an expense the guest writes.
 *
 * In a group: that group's current members. Outside one: exactly the guest and
 * the owner of the friend link, which is the only 1:1 relationship the link
 * describes.
 */
export async function writablePeople(
  database: DB,
  scope: GuestScope,
  groupId: string | null,
): Promise<{ ok: true; allowed: Set<string> } | { ok: false; error: string }> {
  if (groupId === null) {
    if (scope.counterpartId === null) {
      return {
        ok: false,
        error: "This link can only add expenses inside its group.",
      };
    }
    return { ok: true, allowed: new Set([scope.actingAs, scope.counterpartId]) };
  }

  if (!scope.groupIds.includes(groupId)) {
    return { ok: false, error: "This link cannot see that group." };
  }

  const members = await database
    .selectFrom("group_members")
    .select("user_id")
    .where("group_id", "=", groupId)
    .where("left_at", "is", null)
    .execute();

  return { ok: true, allowed: new Set(members.map((m) => m.user_id)) };
}

// ---------------------------------------------------------------------------
// Owner-side listing and revocation
// ---------------------------------------------------------------------------

export interface LinkSummary {
  id: string;
  kind: LinkKind;
  groupId: string | null;
  userId: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** True once expiry has passed; the row is still live but the link is not. */
  expired: boolean;
  /** Owner-facing URL. Null only for rows minted before token_secret existed. */
  url: string | null;
}

function summarise(row: {
  id: string;
  kind: string;
  group_id: string | null;
  user_id: string | null;
  created_by: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  token_secret: string | null;
}): LinkSummary {
  return {
    id: row.id,
    kind: row.kind as LinkKind,
    groupId: row.group_id,
    userId: row.user_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    expired: row.expires_at !== null && new Date(row.expires_at) < new Date(),
    url: row.token_secret ? guestUrl(row.token_secret) : null,
  };
}

/** Live links for a group: the general one plus any per-member ones. */
export async function listGroupLinks(
  database: DB,
  groupId: string,
): Promise<LinkSummary[]> {
  const rows = await database
    .selectFrom("access_links")
    .select([
      "id", "kind", "group_id", "user_id", "created_by",
      "created_at", "expires_at", "last_used_at", "token_secret",
    ])
    .where("group_id", "=", groupId)
    .where("revoked_at", "is", null)
    .orderBy("kind")
    .orderBy("created_at")
    .execute();

  return rows.map(summarise);
}

/** The live friend link one owner holds for one ghost, if there is one. */
export async function findFriendLink(
  database: DB,
  ownerId: string,
  friendId: string,
): Promise<LinkSummary | null> {
  const row = await database
    .selectFrom("access_links")
    .select([
      "id", "kind", "group_id", "user_id", "created_by",
      "created_at", "expires_at", "last_used_at", "token_secret",
    ])
    .where("kind", "=", "friend")
    .where("created_by", "=", ownerId)
    .where("user_id", "=", friendId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();

  return row ? summarise(row) : null;
}

export async function revokeAccessLink(database: DB, id: string): Promise<void> {
  await database
    .updateTable("access_links")
    .set({ revoked_at: new Date().toISOString() })
    .where("id", "=", id)
    .where("revoked_at", "is", null)
    .execute();
}

/**
 * Kills the member link of someone who has just left a group.
 *
 * Removing a member and leaving a working link that acts as them in that group
 * would be a revocation that did not revoke. The general link is untouched:
 * turning that off is a separate decision.
 */
export async function revokeMemberLinks(
  database: DB,
  groupId: string,
  userId: string,
): Promise<void> {
  await database
    .updateTable("access_links")
    .set({ revoked_at: new Date().toISOString() })
    .where("kind", "=", "group_member")
    .where("group_id", "=", groupId)
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .execute();
}
