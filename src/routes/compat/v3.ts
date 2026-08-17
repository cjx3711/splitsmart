/**
 * Splitwise-compatible API, mounted at /api/sw/v3.0.
 *
 * GOAL: a client written against Splitwise should work against SplitSmart by
 * changing only its base URL. Today this implements the six endpoints that
 * splitwise-to-toshl actually calls; docs/SPLITWISE_COMPAT.md tracks the full
 * surface and what is still missing.
 *
 * RULES FOR THIS DIRECTORY:
 *   1. Never change a response shape to be "nicer", except the documented ID
 *      break: entity ids are ULID strings, not Splitwise integers. See
 *      docs/SPLITWISE_COMPAT.md. Category ids stay integers.
 *   2. Money crosses this boundary as decimal strings, and only here.
 *   3. New native features get native routes. Do not extend v3.0 with fields
 *      Splitwise never had; clients may validate strictly.
 */
import { Hono } from "hono";
import { db } from "../../db/index.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import { getPairwiseBalances, getBalanceBetween } from "../../domain/balances.ts";
import { listRelatedUserIds } from "../../domain/friends.ts";
import { createExpense } from "../../domain/expenses.ts";
import { parseAmount } from "../../domain/money.ts";
import { isUlid } from "../../domain/ulid.ts";
import {
  serializeCurrentUser,
  serializeFriend,
  serializeExpense,
  serializeCategory,
  parseFlattenedUsers,
  type DecimalPlacesLookup,
  type SerializableUser,
} from "./serializers.ts";

export const compatV3 = new Hono<AppEnv>();

compatV3.use("*", requireAuth);

/** Currency decimals are tiny and static; cache for the process lifetime. */
let decimalsCache: Map<string, number> | null = null;

async function decimalPlaces(): Promise<DecimalPlacesLookup> {
  if (!decimalsCache) {
    const rows = await db.selectFrom("currencies").select(["code", "decimal_places"]).execute();
    decimalsCache = new Map(rows.map((r) => [r.code, r.decimal_places]));
  }
  const cache = decimalsCache;
  return (code: string) => cache.get(code.toUpperCase()) ?? 2;
}

const USER_COLUMNS = [
  "id",
  "first_name",
  "last_name",
  "email",
  "avatar_url",
  "default_currency",
  "is_ghost",
] as const;

type UserRow = {
  id: string;
  first_name: string;
  last_name: string | null;
  email: string | null;
  avatar_url: string | null;
  default_currency: string;
  is_ghost: number;
};

function toSerializableUser(user: UserRow): SerializableUser {
  return {
    id: user.id,
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    avatar_url: user.avatar_url,
    default_currency: user.default_currency,
    is_ghost: user.is_ghost,
  };
}

// ---------------------------------------------------------------------------
// GET /get_current_user
// ---------------------------------------------------------------------------
compatV3.get("/get_current_user", async (c) => {
  const auth = c.get("user");

  const user = await db
    .selectFrom("users")
    .select(USER_COLUMNS)
    .where("id", "=", auth.id)
    .executeTakeFirst();

  if (!user) return c.json({ error: "User not found" }, 404);

  return c.json({ user: serializeCurrentUser(toSerializableUser(user)) });
});

// ---------------------------------------------------------------------------
// GET /get_friends
// ---------------------------------------------------------------------------
// "Friends" here means everyone the caller shares a group or an expense with.
// Splitwise has explicit friendships; we derive the set so that joining a group
// via invite link immediately makes those people visible, with no extra step.
compatV3.get("/get_friends", async (c) => {
  const auth = c.get("user");
  const decimals = await decimalPlaces();

  // Shared with the native friends list so the two can never disagree about
  // who counts as a friend. The response shape below is still frozen.
  const ids = await listRelatedUserIds(db, auth.id);
  if (ids.length === 0) return c.json({ friends: [] });

  const [users, balances] = await Promise.all([
    db.selectFrom("users").select(USER_COLUMNS).where("id", "in", ids)
      .where("deleted_at", "is", null).execute(),
    getPairwiseBalances(db, auth.id),
  ]);

  const balanceByUser = new Map(balances.map((b) => [b.otherUserId, b.balances]));

  const friends = users.map((u) =>
    serializeFriend(toSerializableUser(u), balanceByUser.get(u.id) ?? [], decimals),
  );

  return c.json({ friends });
});

// ---------------------------------------------------------------------------
// GET /get_friend/:id
// ---------------------------------------------------------------------------
compatV3.get("/get_friend/:id", async (c) => {
  const auth = c.get("user");
  const friendId = c.req.param("id");
  if (!isUlid(friendId)) return c.json({ error: "Invalid friend id" }, 400);

  const decimals = await decimalPlaces();

  const user = await db
    .selectFrom("users")
    .select(USER_COLUMNS)
    .where("id", "=", friendId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  if (!user) return c.json({ error: "Friend not found" }, 404);

  const balances = await getBalanceBetween(db, auth.id, user.id);
  return c.json({ friend: serializeFriend(toSerializableUser(user), balances, decimals) });
});

// ---------------------------------------------------------------------------
// GET /get_categories
// ---------------------------------------------------------------------------
compatV3.get("/get_categories", async (c) => {
  const rows = await db
    .selectFrom("categories")
    .select(["id", "parent_id", "name", "icon", "sort_order"])
    .orderBy("sort_order")
    .orderBy("id")
    .execute();

  const parents = rows.filter((r) => r.parent_id === null);
  const childrenByParent = new Map<number, typeof rows>();
  for (const row of rows) {
    if (row.parent_id === null) continue;
    const list = childrenByParent.get(row.parent_id) ?? [];
    list.push(row);
    childrenByParent.set(row.parent_id, list);
  }

  const categories = parents.map((parent) =>
    serializeCategory({
      id: parent.id,
      name: parent.name,
      icon: parent.icon,
      children: (childrenByParent.get(parent.id) ?? []).map((child) => ({
        id: child.id,
        name: child.name,
        icon: child.icon,
      })),
    }),
  );

  return c.json({ categories });
});

// ---------------------------------------------------------------------------
// GET /get_expenses
// ---------------------------------------------------------------------------
// Params supported: friend_id, group_id, dated_after, dated_before, limit, offset.
// Deleted expenses are RETURNED (with deleted_at set), not filtered; clients
// filter them out themselves, and hiding them would break incremental sync.
compatV3.get("/get_expenses", async (c) => {
  const auth = c.get("user");
  const decimals = await decimalPlaces();

  const limit = clamp(Number(c.req.query("limit") ?? 20), 0, 1000) || 20;
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
  const friendParam = c.req.query("friend_id");
  const groupParam = c.req.query("group_id");
  const datedAfter = c.req.query("dated_after");
  const datedBefore = c.req.query("dated_before");

  if (friendParam && !isUlid(friendParam)) return c.json({ expenses: [] });
  if (groupParam && !isUlid(groupParam)) return c.json({ expenses: [] });
  const friendId = friendParam ?? null;
  const groupId = groupParam ?? null;

  let query = db
    .selectFrom("expenses")
    .leftJoin("categories", "categories.id", "expenses.category_id")
    .select([
      "expenses.id",
      "expenses.group_id",
      "expenses.description",
      "expenses.details",
      "expenses.cost_minor",
      "expenses.currency_code",
      "expenses.date",
      "expenses.category_id",
      "expenses.is_payment",
      "expenses.created_by",
      "expenses.created_at",
      "expenses.updated_at",
      "expenses.deleted_at",
      "categories.name as category_name",
    ])
    // Only expenses the caller participates in.
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("expense_users")
          .select("expense_users.user_id")
          .whereRef("expense_users.expense_id", "=", "expenses.id")
          .where("expense_users.user_id", "=", auth.id),
      ),
    );

  if (friendId !== null) {
    query = query.where((eb) =>
      eb.exists(
        eb
          .selectFrom("expense_users")
          .select("expense_users.user_id")
          .whereRef("expense_users.expense_id", "=", "expenses.id")
          .where("expense_users.user_id", "=", friendId),
      ),
    );
  }
  if (groupId !== null) query = query.where("expenses.group_id", "=", groupId);
  if (datedAfter) query = query.where("expenses.date", ">=", normaliseDateParam(datedAfter));
  if (datedBefore) query = query.where("expenses.date", "<=", normaliseDateParam(datedBefore, true));

  const expenses = await query
    .orderBy("expenses.date", "desc")
    .orderBy("expenses.id", "desc")
    .limit(limit)
    .offset(offset)
    .execute();

  if (expenses.length === 0) return c.json({ expenses: [] });

  const expenseIds = expenses.map((e) => e.id);

  const [shares, repayments] = await Promise.all([
    db
      .selectFrom("expense_users")
      .innerJoin("users", "users.id", "expense_users.user_id")
      .select([
        "expense_users.expense_id",
        "users.id as user_id",
        "expense_users.paid_share_minor",
        "expense_users.owed_share_minor",
        "users.id as u_id",
        "users.first_name",
        "users.last_name",
        "users.email",
        "users.avatar_url",
        "users.default_currency",
        "users.is_ghost",
      ])
      .where("expense_users.expense_id", "in", expenseIds)
      .execute(),
    db
      .selectFrom("expense_repayments")
      .innerJoin("users as from_user", "from_user.id", "expense_repayments.from_user_id")
      .innerJoin("users as to_user", "to_user.id", "expense_repayments.to_user_id")
      .select([
        "expense_repayments.expense_id",
        "from_user.id as from_user_id",
        "to_user.id as to_user_id",
        "expense_repayments.amount_minor",
      ])
      .where("expense_repayments.expense_id", "in", expenseIds)
      .orderBy("expense_repayments.seq")
      .execute(),
  ]);

  const sharesByExpense = groupBy(shares, (s) => s.expense_id);
  const repaymentsByExpense = groupBy(repayments, (r) => r.expense_id);

  const serialized = expenses.map((expense) =>
    serializeExpense(
      {
        id: expense.id,
        group_id: expense.group_id,
        description: expense.description,
        details: expense.details,
        cost_minor: expense.cost_minor,
        currency_code: expense.currency_code,
        date: expense.date,
        category_id: expense.category_id,
        category_name: expense.category_name,
        is_payment: expense.is_payment,
        created_by: expense.created_by,
        created_at: expense.created_at,
        updated_at: expense.updated_at,
        deleted_at: expense.deleted_at,
      },
      (sharesByExpense.get(expense.id) ?? []).map((s) => ({
        user_id: s.user_id,
        paid_share_minor: s.paid_share_minor,
        owed_share_minor: s.owed_share_minor,
        user: {
          id: s.u_id,
          first_name: s.first_name,
          last_name: s.last_name,
          email: s.email,
          avatar_url: s.avatar_url,
          default_currency: s.default_currency,
          is_ghost: s.is_ghost,
        },
      })),
      repaymentsByExpense.get(expense.id) ?? [],
      decimals,
    ),
  );

  return c.json({ expenses: serialized });
});

// ---------------------------------------------------------------------------
// POST /create_expense
// ---------------------------------------------------------------------------
// Accepts Splitwise's flattened body. Real Splitwise returns 200 with a
// populated `errors` object on validation failure; we return a proper 4xx AND
// the `errors` key, which is strictly more useful and still satisfies clients
// that only check `res.ok`.
compatV3.post("/create_expense", async (c) => {
  const auth = c.get("user");
  const decimals = await decimalPlaces();

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ expenses: [], errors: { base: ["Request body must be JSON"] } }, 400);
  }

  const currencyCode = String(body.currency_code ?? auth.defaultCurrency).toUpperCase();
  const dp = decimals(currencyCode);

  try {
    const costMinor = parseAmount(String(body.cost ?? ""), dp);
    if (costMinor < 0) throw new Error("cost must not be negative");

    const rawUsers = parseFlattenedUsers(body);
    if (rawUsers.length === 0) {
      return c.json(
        { expenses: [], errors: { base: ["At least one users__N__user_id is required"] } },
        400,
      );
    }

    const participants = [];
    for (const u of rawUsers) {
      const userId = String(u.user_id ?? "");
      if (!isUlid(userId)) throw new Error(`Invalid user_id: ${String(u.user_id)}`);
      const exists = await db
        .selectFrom("users")
        .select("id")
        .where("id", "=", userId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!exists) throw new Error(`Unknown user_id: ${userId}`);
      participants.push({
        userId,
        paidMinor: parseAmount(String(u.paid_share ?? "0"), dp),
        // Splitwise's create_expense always sends explicit owed shares, so this
        // maps to our "exact" split type rather than being recomputed.
        input: parseAmount(String(u.owed_share ?? "0"), dp),
      });
    }

    let groupId: string | null = null;
    if (body.group_id) {
      const gid = String(body.group_id);
      if (!isUlid(gid)) throw new Error("Invalid group_id");
      const group = await db
        .selectFrom("groups")
        .select("id")
        .where("id", "=", gid)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!group) throw new Error("Unknown group_id");
      groupId = group.id;
    }

    const expenseId = await createExpense({
      groupId,
      description: String(body.description ?? "").trim() || "Expense",
      details: body.details ? String(body.details) : null,
      costMinor,
      currencyCode,
      date: String(body.date ?? new Date().toISOString()),
      categoryId: body.category_id ? Number(body.category_id) : null,
      splitType: "exact",
      createdBy: auth.id,
      participants,
    });

    // Echo the created expense back in the same shape get_expenses returns.
    const created = await db
      .selectFrom("expenses")
      .leftJoin("categories", "categories.id", "expenses.category_id")
      .select([
        "expenses.id",
        "expenses.group_id",
        "expenses.description", "expenses.details",
        "expenses.cost_minor", "expenses.currency_code", "expenses.date",
        "expenses.category_id", "expenses.is_payment",
        "expenses.created_by",
        "expenses.created_at", "expenses.updated_at", "expenses.deleted_at",
        "categories.name as category_name",
      ])
      .where("expenses.id", "=", expenseId)
      .executeTakeFirstOrThrow();

    const shares = await db
      .selectFrom("expense_users")
      .innerJoin("users", "users.id", "expense_users.user_id")
      .select([
        "users.id as user_id", "expense_users.paid_share_minor",
        "expense_users.owed_share_minor", "users.id as u_id", "users.first_name",
        "users.last_name", "users.email", "users.avatar_url",
        "users.default_currency", "users.is_ghost",
      ])
      .where("expense_users.expense_id", "=", expenseId)
      .execute();

    const repayments = await db
      .selectFrom("expense_repayments")
      .innerJoin("users as from_user", "from_user.id", "expense_repayments.from_user_id")
      .innerJoin("users as to_user", "to_user.id", "expense_repayments.to_user_id")
      .select([
        "from_user.id as from_user_id",
        "to_user.id as to_user_id",
        "expense_repayments.amount_minor",
      ])
      .where("expense_repayments.expense_id", "=", expenseId)
      .orderBy("expense_repayments.seq")
      .execute();

    return c.json({
      expenses: [
        serializeExpense(
          created,
          shares.map((s) => ({
            user_id: s.user_id,
            paid_share_minor: s.paid_share_minor,
            owed_share_minor: s.owed_share_minor,
            user: {
              id: s.u_id, first_name: s.first_name, last_name: s.last_name,
              email: s.email, avatar_url: s.avatar_url,
              default_currency: s.default_currency, is_ghost: s.is_ghost,
            },
          })),
          repayments,
          decimals,
        ),
      ],
      errors: {},
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not create expense";
    return c.json({ expenses: [], errors: { base: [message] } }, 400);
  }
});

// ---------------------------------------------------------------------------

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function normaliseDateParam(value: string, endOfDay = false): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return endOfDay ? `${value}T23:59:59Z` : `${value}T00:00:00Z`;
  }
  return value;
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = map.get(k) ?? [];
    list.push(item);
    map.set(k, list);
  }
  return map;
}
