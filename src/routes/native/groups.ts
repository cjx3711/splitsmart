/**
 * Native group and expense routes.
 *
 * These speak the clean internal model: integer minor units, nested objects,
 * camelCase. The Splitwise wire format is confined to src/routes/compat/.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db, transaction } from "../../db/index.ts";
import { env } from "../../env.ts";
import { generateToken } from "../../auth/password.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import { getGroupBalances, getTotalBalance, simplifyDebts } from "../../domain/balances.ts";
import { createExpense, deleteExpense, createPayment } from "../../domain/expenses.ts";
import { listRelatedUserIds } from "../../domain/friends.ts";
import { expenseBodySchema, genericExpenseBodySchema } from "./expense-schema.ts";

export const groupRoutes = new Hono<AppEnv>();
groupRoutes.use("*", requireAuth);

/** Throws a 403-shaped result if the caller isn't in the group. */
async function assertMember(groupId: number, userId: number) {
  const membership = await db
    .selectFrom("group_members")
    .select(["role"])
    .where("group_id", "=", groupId)
    .where("user_id", "=", userId)
    .where("left_at", "is", null)
    .executeTakeFirst();
  return membership ?? null;
}

groupRoutes.get("/", async (c) => {
  const auth = c.get("user");

  const groups = await db
    .selectFrom("groups")
    .innerJoin("group_members", "group_members.group_id", "groups.id")
    .select([
      "groups.id", "groups.name", "groups.group_type",
      "groups.default_currency", "groups.simplify_by_default",
    ])
    .where("group_members.user_id", "=", auth.id)
    .where("group_members.left_at", "is", null)
    .where("groups.deleted_at", "is", null)
    .orderBy("groups.name")
    .execute();

  return c.json({ groups, totalBalance: await getTotalBalance(db, auth.id) });
});

groupRoutes.post(
  "/",
  zValidator(
    "json",
    z.object({
      name: z.string().min(1).max(200),
      groupType: z.enum(["home", "trip", "couple", "event", "project", "other"]).default("other"),
      defaultCurrency: z.string().length(3).toUpperCase().default("USD"),
      simplifyByDefault: z.boolean().default(false),
    }),
  ),
  async (c) => {
    const auth = c.get("user");
    const input = c.req.valid("json");
    const inviteToken = generateToken(24);

    const group = await transaction(async (trx) => {
      const created = await trx
        .insertInto("groups")
        .values({
          name: input.name,
          group_type: input.groupType,
          default_currency: input.defaultCurrency,
          simplify_by_default: input.simplifyByDefault ? 1 : 0,
          invite_token: inviteToken,
          created_by: auth.id,
        })
        .returning(["id", "name", "group_type", "default_currency"])
        .executeTakeFirstOrThrow();

      await trx
        .insertInto("group_members")
        .values({ group_id: created.id, user_id: auth.id, role: "owner", joined_via: "creator" })
        .execute();

      return created;
    });

    return c.json(
      { group, inviteUrl: `${env.APP_ORIGIN}/join/${inviteToken}` },
      201,
    );
  },
);

groupRoutes.get("/:id", async (c) => {
  const auth = c.get("user");
  const groupId = Number(c.req.param("id"));

  if (!(await assertMember(groupId, auth.id))) {
    return c.json({ error: "Not a member of this group" }, 403);
  }

  const group = await db
    .selectFrom("groups")
    .select([
      "id", "name", "group_type", "default_currency",
      "simplify_by_default", "invite_token",
    ])
    .where("id", "=", groupId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  if (!group) return c.json({ error: "Group not found" }, 404);

  const members = await db
    .selectFrom("group_members")
    .innerJoin("users", "users.id", "group_members.user_id")
    .select([
      "users.id", "users.first_name", "users.last_name",
      "users.is_ghost", "group_members.role", "group_members.joined_via",
    ])
    .where("group_members.group_id", "=", groupId)
    .where("group_members.left_at", "is", null)
    .execute();

  const balances = await getGroupBalances(db, groupId);

  return c.json({
    group: {
      ...group,
      invite_token: undefined,
      inviteUrl: group.invite_token ? `${env.APP_ORIGIN}/join/${group.invite_token}` : null,
    },
    members,
    balances,
  });
});

/** Suggested settle-up transfers, per currency. Presentational only. */
groupRoutes.get("/:id/settle", async (c) => {
  const auth = c.get("user");
  const groupId = Number(c.req.param("id"));

  if (!(await assertMember(groupId, auth.id))) {
    return c.json({ error: "Not a member of this group" }, 403);
  }

  const balances = await getGroupBalances(db, groupId);
  const byCurrency = new Map<string, Array<{ userId: number; amountMinor: number }>>();

  for (const member of balances) {
    for (const b of member.balances) {
      const list = byCurrency.get(b.currencyCode) ?? [];
      list.push({ userId: member.userId, amountMinor: b.amountMinor });
      byCurrency.set(b.currencyCode, list);
    }
  }

  const suggestions = [...byCurrency.entries()].map(([currencyCode, entries]) => ({
    currencyCode,
    transfers: simplifyDebts(entries),
  }));

  return c.json({ suggestions });
});

groupRoutes.get("/:id/expenses", async (c) => {
  const auth = c.get("user");
  const groupId = Number(c.req.param("id"));

  if (!(await assertMember(groupId, auth.id))) {
    return c.json({ error: "Not a member of this group" }, 403);
  }

  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 500);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);

  const expenses = await db
    .selectFrom("expenses")
    .leftJoin("categories", "categories.id", "expenses.category_id")
    .select([
      "expenses.id", "expenses.description", "expenses.cost_minor",
      "expenses.currency_code", "expenses.date", "expenses.is_payment",
      "expenses.split_type", "expenses.split_meta", "categories.name as category_name",
    ])
    .where("expenses.group_id", "=", groupId)
    .where("expenses.deleted_at", "is", null)
    .orderBy("expenses.date", "desc")
    .orderBy("expenses.id", "desc")
    .limit(limit)
    .offset(offset)
    .execute();

  if (expenses.length === 0) return c.json({ expenses: [] });

  const shares = await db
    .selectFrom("expense_users")
    .select(["expense_id", "user_id", "paid_share_minor", "owed_share_minor", "split_input"])
    .where("expense_id", "in", expenses.map((e) => e.id))
    .execute();

  const sharesByExpense = new Map<number, typeof shares>();
  for (const s of shares) {
    const list = sharesByExpense.get(s.expense_id) ?? [];
    list.push(s);
    sharesByExpense.set(s.expense_id, list);
  }

  return c.json({
    expenses: expenses.map((e) => ({ ...e, shares: sharesByExpense.get(e.id) ?? [] })),
  });
});

groupRoutes.post(
  "/:id/expenses",
  zValidator("json", expenseBodySchema),
  async (c) => {
    const auth = c.get("user");
    const groupId = Number(c.req.param("id"));

    if (!(await assertMember(groupId, auth.id))) {
      return c.json({ error: "Not a member of this group" }, 403);
    }

    const input = c.req.valid("json");

    try {
      const expenseId = await createExpense({
        ...input,
        groupId,
        details: input.details ?? null,
        categoryId: input.categoryId ?? null,
        createdBy: auth.id,
      });
      return c.json({ id: expenseId }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Could not create expense" },
        400,
      );
    }
  },
);

groupRoutes.post(
  "/:id/payments",
  zValidator(
    "json",
    z.object({
      fromUserId: z.number().int().positive(),
      toUserId: z.number().int().positive(),
      amountMinor: z.number().int().positive(),
      currencyCode: z.string().length(3).toUpperCase(),
      date: z.string().optional(),
    }),
  ),
  async (c) => {
    const auth = c.get("user");
    const groupId = Number(c.req.param("id"));

    if (!(await assertMember(groupId, auth.id))) {
      return c.json({ error: "Not a member of this group" }, 403);
    }

    const input = c.req.valid("json");

    try {
      const id = await createPayment({ ...input, groupId, createdBy: auth.id });
      return c.json({ id }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Could not record payment" },
        400,
      );
    }
  },
);

export const expenseRoutes = new Hono<AppEnv>();
expenseRoutes.use("*", requireAuth);

/**
 * Every expense the caller is a participant of, group and one-on-one alike.
 *
 * Backs the "All expenses" screen. Membership is decided by expense_users, not
 * group membership, so leaving a group does not hide history you are part of.
 */
/**
 * Create an expense anywhere: in a group, or in no group at all.
 *
 * The group-scoped and friend-scoped endpoints stay as they are — they are what
 * the compat layer and existing clients use — but neither can express the one
 * shape the add-expense dialog needs: several people, chosen freely, possibly
 * with no group. This is that endpoint, and it is the one the web UI posts to.
 *
 * Who may appear on the expense:
 *
 *   in a group — its current members, enforced by createExpense itself
 *   no group   — you, plus anyone you already share money history with
 *                (src/domain/friends.ts is the ONE definition of that)
 *
 * The caller must be on the expense either way. A non-group expense between two
 * other people would create a balance neither of them can see and this app has
 * no screen for.
 */
expenseRoutes.post("/", zValidator("json", genericExpenseBodySchema), async (c) => {
  const auth = c.get("user");
  const { groupId = null, ...input } = c.req.valid("json");

  if (!input.participants.some((p) => p.userId === auth.id)) {
    return c.json({ error: "You have to be one of the people on this expense." }, 400);
  }

  if (groupId !== null) {
    if (!(await assertMember(groupId, auth.id))) {
      return c.json({ error: "Not a member of this group" }, 403);
    }
  } else {
    const allowed = new Set([auth.id, ...(await listRelatedUserIds(db, auth.id))]);
    const strangers = input.participants.filter((p) => !allowed.has(p.userId));
    if (strangers.length > 0) {
      return c.json(
        { error: "A non-group expense can only involve you and people you share history with." },
        400,
      );
    }
  }

  try {
    const expenseId = await createExpense({
      ...input,
      groupId,
      details: input.details ?? null,
      categoryId: input.categoryId ?? null,
      createdBy: auth.id,
    });
    return c.json({ id: expenseId }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not create expense" }, 400);
  }
});

expenseRoutes.get("/", async (c) => {
  const auth = c.get("user");
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);

  const expenses = await db
    .selectFrom("expenses")
    .innerJoin("expense_users", "expense_users.expense_id", "expenses.id")
    .leftJoin("categories", "categories.id", "expenses.category_id")
    .leftJoin("groups", "groups.id", "expenses.group_id")
    .select([
      "expenses.id", "expenses.description", "expenses.cost_minor",
      "expenses.currency_code", "expenses.date", "expenses.is_payment",
      "expenses.split_type", "expenses.split_meta", "expenses.group_id",
      "categories.name as category_name", "groups.name as group_name",
    ])
    .where("expense_users.user_id", "=", auth.id)
    .where("expenses.deleted_at", "is", null)
    .orderBy("expenses.date", "desc")
    .orderBy("expenses.id", "desc")
    .limit(limit)
    .offset(offset)
    .execute();

  if (expenses.length === 0) return c.json({ expenses: [] });

  const shares = await db
    .selectFrom("expense_users")
    .select(["expense_id", "user_id", "paid_share_minor", "owed_share_minor", "split_input"])
    .where("expense_id", "in", expenses.map((e) => e.id))
    .execute();

  const byExpense = new Map<number, typeof shares>();
  for (const s of shares) {
    const list = byExpense.get(s.expense_id) ?? [];
    list.push(s);
    byExpense.set(s.expense_id, list);
  }

  return c.json({
    expenses: expenses.map((e) => ({ ...e, shares: byExpense.get(e.id) ?? [] })),
  });
});

/**
 * Currencies this user has actually used, most-used first.
 *
 * Backs the "Popular" section of the currency picker — a static top-10 list is
 * a poor default for someone whose expenses are mostly in a currency it
 * doesn't include. Deleted expenses are excluded so removing a one-off mistake
 * in a rare currency doesn't keep it pinned at the top forever.
 */
expenseRoutes.get("/currencies/frequent", async (c) => {
  const auth = c.get("user");

  const rows = await db
    .selectFrom("expenses")
    .innerJoin("expense_users", "expense_users.expense_id", "expenses.id")
    .select("expenses.currency_code")
    .select((eb) => eb.fn.countAll().as("count"))
    .where("expense_users.user_id", "=", auth.id)
    .where("expenses.deleted_at", "is", null)
    .groupBy("expenses.currency_code")
    .orderBy("count", "desc")
    .limit(10)
    .execute();

  return c.json({ codes: rows.map((r) => r.currency_code) });
});

expenseRoutes.delete("/:id", async (c) => {
  const auth = c.get("user");
  const expenseId = Number(c.req.param("id"));

  // Only a participant may delete an expense.
  const participant = await db
    .selectFrom("expense_users")
    .select("user_id")
    .where("expense_id", "=", expenseId)
    .where("user_id", "=", auth.id)
    .executeTakeFirst();

  if (!participant) return c.json({ error: "Not found" }, 404);

  await deleteExpense(expenseId, auth.id);
  return c.json({ ok: true });
});

export const categoryRoutes = new Hono<AppEnv>();

categoryRoutes.get("/", async (c) => {
  const categories = await db
    .selectFrom("categories")
    .select(["id", "parent_id", "name", "icon", "is_default"])
    .orderBy("sort_order")
    .orderBy("id")
    .execute();
  return c.json({ categories });
});

categoryRoutes.get("/currencies", async (c) => {
  const currencies = await db
    .selectFrom("currencies")
    .select(["code", "decimal_places", "symbol", "name"])
    .orderBy("code")
    .execute();
  return c.json({ currencies });
});
