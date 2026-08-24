/**
 * The queries that build `/api/v1/sync/*` payloads.
 *
 * ONE loader per entity, shared by bootstrap, pull and snapshot. That is the
 * whole point of this file: those three endpoints deliver the same rows by three
 * different routes (everything you can see / what changed since `seq` / catch up
 * on one thing), and if they disagreed about the shape of an expense then which
 * screen worked would depend on how the client had got there.
 *
 * The shapes themselves live in src/domain/sync-types.ts, which is pure types so
 * the browser can import the same definitions. Everything here loads whole
 * entities: no field-level diffs, ever.
 */
import type { DB } from "../../db/index.ts";
import type {
  SyncCategory,
  SyncComment,
  SyncCurrency,
  SyncExpense,
  SyncFriendship,
  SyncGroup,
  SyncGroupMember,
  SyncRepayment,
  SyncShare,
  SyncUser,
} from "../../domain/sync-types.ts";
import { importRoundingOf, repeatPausedOf } from "../../domain/metadata.ts";
import { knownEmail } from "../../domain/person.ts";
import { parseAvatarPattern } from "../../domain/avatar-pattern.ts";

export type {
  SyncCategory,
  SyncComment,
  SyncCurrency,
  SyncExpense,
  SyncFriendship,
  SyncGroup,
  SyncGroupMember,
  SyncShare,
  SyncUser,
};

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const USER_COLUMNS = [
  "id",
  "name",
  "nickname",
  "icon_letters",
  "icon_emoji",
  "icon_hue",
  "icon_pattern",
  "email",
  "invite_email",
  "is_ghost",
  "default_currency",
  "merged_into_user_id",
  "deleted_at",
] as const;

type UserRow = {
  id: string;
  name: string;
  nickname: string | null;
  icon_letters: string | null;
  icon_emoji: string | null;
  icon_hue: number | null;
  icon_pattern: string | null;
  email: string | null;
  invite_email: string | null;
  is_ghost: number;
  default_currency: string;
  merged_into_user_id: string | null;
  deleted_at: string | null;
};

export function toSyncUser(row: UserRow): SyncUser {
  return {
    id: row.id,
    name: row.name,
    nickname: row.nickname,
    iconLetters: row.icon_letters,
    iconEmoji: row.icon_emoji,
    iconHue: row.icon_hue,
    iconPattern: parseAvatarPattern(row.icon_pattern),
    email: knownEmail(row),
    isGhost: row.is_ghost === 1,
    defaultCurrency: row.default_currency,
    mergedIntoUserId: row.merged_into_user_id,
    deletedAt: row.deleted_at,
  };
}

/**
 * Loads the named users in one query and returns a lookup.
 *
 * Every serializer below takes one of these rather than doing its own join, so
 * building a page of a hundred expenses is one users query instead of a hundred.
 */
export async function loadUsers(
  database: DB,
  ids: Iterable<string>,
): Promise<Map<string, SyncUser>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();

  const rows = await database
    .selectFrom("users")
    .select(USER_COLUMNS)
    .where("id", "in", unique)
    .execute();

  return new Map(rows.map((row) => [row.id, toSyncUser(row)]));
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

const EXPENSE_COLUMNS = [
  "id",
  "group_id",
  "description",
  "details",
  "cost_minor",
  "currency_code",
  "date",
  "category_id",
  "split_type",
  "split_meta",
  "is_payment",
  "payment_method",
  "repeat_interval",
  "next_repeat",
  "repeat_of",
  "metadata",
  "version",
  "created_by",
  "updated_by",
  "created_at",
  "updated_at",
  "deleted_at",
] as const;

/**
 * Loads whole expenses, shares and people included.
 *
 * Three queries regardless of how many ids are asked for. Order follows the
 * caller's id list is NOT guaranteed; nothing consuming this cares, because the
 * client keys by id.
 */
export async function loadExpenses(
  database: DB,
  ids: string[],
): Promise<SyncExpense[]> {
  if (ids.length === 0) return [];

  const rows = await database
    .selectFrom("expenses")
    .select(EXPENSE_COLUMNS)
    .where("id", "in", ids)
    .execute();

  if (rows.length === 0) return [];

  const shares = await database
    .selectFrom("expense_users")
    .select(["expense_id", "user_id", "paid_share_minor", "owed_share_minor", "split_input"])
    .where("expense_id", "in", rows.map((r) => r.id))
    .orderBy("user_id")
    .execute();

  const sharesByExpense = new Map<string, SyncShare[]>();
  for (const share of shares) {
    const list = sharesByExpense.get(share.expense_id) ?? [];
    list.push({
      userId: share.user_id,
      paidShareMinor: share.paid_share_minor,
      owedShareMinor: share.owed_share_minor,
      splitInput: share.split_input,
    });
    sharesByExpense.set(share.expense_id, list);
  }

  const repayments = await database
    .selectFrom("expense_repayments")
    .select(["expense_id", "from_user_id", "to_user_id", "amount_minor"])
    .where("expense_id", "in", rows.map((r) => r.id))
    .orderBy("seq")
    .execute();

  const repaymentsByExpense = new Map<string, SyncRepayment[]>();
  for (const row of repayments) {
    const list = repaymentsByExpense.get(row.expense_id) ?? [];
    list.push({
      fromUserId: row.from_user_id,
      toUserId: row.to_user_id,
      amountMinor: row.amount_minor,
    });
    repaymentsByExpense.set(row.expense_id, list);
  }

  const people = await loadUsers(database, shares.map((s) => s.user_id));

  return rows.map((row) => {
    const expenseShares = sharesByExpense.get(row.id) ?? [];
    return {
      id: row.id,
      groupId: row.group_id,
      description: row.description,
      details: row.details,
      costMinor: row.cost_minor,
      currencyCode: row.currency_code,
      date: row.date,
      categoryId: row.category_id,
      splitType: row.split_type,
      splitMeta: row.split_meta,
      isPayment: row.is_payment === 1,
      paymentMethod: row.payment_method,
      repeatInterval: row.repeat_interval,
      nextRepeat: row.next_repeat,
      repeatOf: row.repeat_of,
      repeatPaused: repeatPausedOf(row.metadata),
      importRounding: importRoundingOf(row.metadata),
      version: row.version,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at,
      shares: expenseShares,
      people: expenseShares
        .map((s) => people.get(s.userId))
        .filter((u): u is SyncUser => u !== undefined),
      repayments: repaymentsByExpense.get(row.id) ?? [],
    };
  });
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

/**
 * Loads comments by id, live and deleted alike.
 *
 * Deleted ones are included because pull has to be able to deliver "this is gone
 * now" for a row the client already has. Bootstrap asks only for live ones.
 */
export async function loadComments(
  database: DB,
  ids: string[],
): Promise<SyncComment[]> {
  if (ids.length === 0) return [];

  const rows = await database
    .selectFrom("comments")
    .select(["id", "expense_id", "user_id", "kind", "content", "created_at", "deleted_at"])
    .where("id", "in", ids)
    .orderBy("created_at")
    .orderBy("id")
    .execute();

  const authors = await loadUsers(database, rows.map((r) => r.user_id));

  return rows.map((row) => ({
    id: row.id,
    expenseId: row.expense_id,
    userId: row.user_id,
    kind: row.kind,
    content: row.content,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    author: authors.get(row.user_id) ?? null,
  }));
}

/** Live comments on the given expenses, oldest first. */
export async function loadCommentsForExpenses(
  database: DB,
  expenseIds: string[],
): Promise<SyncComment[]> {
  if (expenseIds.length === 0) return [];

  const ids = await database
    .selectFrom("comments")
    .select("id")
    .where("expense_id", "in", expenseIds)
    .where("deleted_at", "is", null)
    .execute();

  return loadComments(database, ids.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Groups, members, friendships
// ---------------------------------------------------------------------------

export async function loadGroups(database: DB, ids: string[]): Promise<SyncGroup[]> {
  if (ids.length === 0) return [];

  const rows = await database
    .selectFrom("groups")
    .select([
      "id",
      "name",
      "group_type",
      "default_currency",
      "simplify_by_default",
      "created_by",
      "deleted_at",
    ])
    .where("id", "in", ids)
    .execute();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    groupType: row.group_type,
    defaultCurrency: row.default_currency,
    simplifyByDefault: row.simplify_by_default === 1,
    createdBy: row.created_by,
    deletedAt: row.deleted_at,
  }));
}

/**
 * Every membership row of the given groups, people who have left included.
 *
 * The departed are needed: they are still on expenses in the group, and a client
 * that dropped them would render those bills with a blank where a name goes.
 */
export async function loadGroupMembers(
  database: DB,
  groupIds: string[],
): Promise<SyncGroupMember[]> {
  if (groupIds.length === 0) return [];

  const rows = await database
    .selectFrom("group_members")
    .select(["group_id", "user_id", "role", "joined_via", "joined_at", "left_at"])
    .where("group_id", "in", groupIds)
    .execute();

  const users = await loadUsers(database, rows.map((r) => r.user_id));

  return rows.map((row) => ({
    groupId: row.group_id,
    userId: row.user_id,
    role: row.role,
    joinedVia: row.joined_via,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    user: users.get(row.user_id) ?? null,
  }));
}

/** One membership, by its composite key. Used by pull for a single log row. */
export async function loadGroupMember(
  database: DB,
  groupId: string,
  userId: string,
): Promise<SyncGroupMember | null> {
  const row = await database
    .selectFrom("group_members")
    .select(["group_id", "user_id", "role", "joined_via", "joined_at", "left_at"])
    .where("group_id", "=", groupId)
    .where("user_id", "=", userId)
    .executeTakeFirst();

  if (!row) return null;

  const users = await loadUsers(database, [row.user_id]);
  return {
    groupId: row.group_id,
    userId: row.user_id,
    role: row.role,
    joinedVia: row.joined_via,
    joinedAt: row.joined_at,
    leftAt: row.left_at,
    user: users.get(row.user_id) ?? null,
  };
}

/**
 * The caller's explicit friendships.
 *
 * DERIVED friends are deliberately not here. There is no row for them
 * (src/domain/friends.ts), and the client recomputes the union locally the same
 * way `listRelatedUserIds` does on the server - from the group memberships and
 * expense shares it already holds.
 */
export async function loadFriendships(
  database: DB,
  userId: string,
): Promise<SyncFriendship[]> {
  const rows = await database
    .selectFrom("friendships")
    .select(["user_a_id", "user_b_id", "created_at"])
    .where((eb) => eb.or([eb("user_a_id", "=", userId), eb("user_b_id", "=", userId)]))
    .execute();

  return serialiseFriendships(database, rows, userId);
}

export async function serialiseFriendships(
  database: DB,
  rows: Array<{ user_a_id: string; user_b_id: string; created_at: string }>,
  viewerId: string,
): Promise<SyncFriendship[]> {
  if (rows.length === 0) return [];

  const others = rows.map((r) => (r.user_a_id === viewerId ? r.user_b_id : r.user_a_id));
  const users = await loadUsers(database, others);

  return rows.map((row) => {
    const otherId = row.user_a_id === viewerId ? row.user_b_id : row.user_a_id;
    return {
      userAId: row.user_a_id,
      userBId: row.user_b_id,
      createdAt: row.created_at,
      otherUser: users.get(otherId) ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * Currencies and the category tree.
 *
 * REQUIRED, not an optimisation. `web/src/money.tsx` refuses to render an amount
 * without its currency's `decimalPlaces` - deliberately, because defaulting to 2
 * is how JPY ends up displayed at a hundredth of its value - so a client with no
 * currencies table shows a screen of dashes rather than a ledger. That is why
 * these travel with the bootstrap rather than being fetched separately and
 * hoped for.
 */
export async function loadCurrencies(database: DB): Promise<SyncCurrency[]> {
  const rows = await database
    .selectFrom("currencies")
    .select(["code", "decimal_places", "symbol", "name"])
    .orderBy("code")
    .execute();

  return rows.map((row) => ({
    code: row.code,
    decimalPlaces: row.decimal_places,
    symbol: row.symbol,
    name: row.name,
  }));
}

export async function loadCategories(database: DB): Promise<SyncCategory[]> {
  const rows = await database
    .selectFrom("categories")
    .select(["id", "parent_id", "name", "icon", "is_default"])
    .orderBy("sort_order")
    .orderBy("id")
    .execute();

  return rows.map((row) => ({
    id: row.id,
    parentId: row.parent_id,
    name: row.name,
    icon: row.icon,
    isDefault: row.is_default === 1,
  }));
}
