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
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import { getGroupBalances, getTotalBalance, simplifyDebts } from "../../domain/balances.ts";
import { createExpense, updateExpense, deleteExpense, createPayment } from "../../domain/expenses.ts";
import { listRelatedUserIds } from "../../domain/friends.ts";
import { revokeMemberLinks } from "../../domain/access-links.ts";
import { expenseBodySchema, genericExpenseBodySchema, ulidSchema } from "./expense-schema.ts";
import { GROUP_TYPES } from "../../domain/group-types.ts";
import { isUlid, ulid } from "../../domain/ulid.ts";

export const groupRoutes = new Hono<AppEnv>();
groupRoutes.use("*", requireAuth);

/** Throws a 403-shaped result if the caller isn't in the group. */
async function assertMember(groupId: string, userId: string) {
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
      groupType: z.enum(GROUP_TYPES).default("other"),
      defaultCurrency: z.string().length(3).toUpperCase().default("USD"),
      simplifyByDefault: z.boolean().default(false),
    }),
  ),
  async (c) => {
    const auth = c.get("user");
    const input = c.req.valid("json");

    // No guest link is minted here. Creating a group is not deciding to share
    // it; the owner mints a link from the group screen when they mean to.
    // See docs/GUEST.md and POST /api/v1/links.
    const group = await transaction(async (trx) => {
      const created = await trx
        .insertInto("groups")
        .values({
          id: ulid(),
          name: input.name,
          group_type: input.groupType,
          default_currency: input.defaultCurrency,
          simplify_by_default: input.simplifyByDefault ? 1 : 0,
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

    return c.json({ group }, 201);
  },
);

groupRoutes.get("/:id", async (c) => {
  const auth = c.get("user");
  const groupId = c.req.param("id");
  if (!isUlid(groupId)) return c.json({ error: "Invalid group id" }, 400);

  const membership = await assertMember(groupId, auth.id);
  if (!membership) {
    return c.json({ error: "Not a member of this group" }, 403);
  }

  const group = await db
    .selectFrom("groups")
    .select(["id", "name", "group_type", "default_currency", "simplify_by_default"])
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

  return c.json({ group, members, balances, role: membership.role });
});

/** Suggested settle-up transfers, per currency. Presentational only. */
groupRoutes.get("/:id/settle", async (c) => {
  const auth = c.get("user");
  const groupId = c.req.param("id");
  if (!isUlid(groupId)) return c.json({ error: "Invalid group id" }, 400);

  if (!(await assertMember(groupId, auth.id))) {
    return c.json({ error: "Not a member of this group" }, 403);
  }

  const balances = await getGroupBalances(db, groupId);
  const byCurrency = new Map<string, Array<{ userId: string; amountMinor: number }>>();

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
  const groupId = c.req.param("id");
  if (!isUlid(groupId)) return c.json({ error: "Invalid group id" }, 400);

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

  const sharesByExpense = new Map<string, typeof shares>();
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
    const groupId = c.req.param("id");
    if (!isUlid(groupId)) return c.json({ error: "Invalid group id" }, 400);

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

/**
 * Adds someone to a group.
 *
 * This exists because opening a link no longer creates a member. Guests pick
 * among names an account holder put there, so the account holder needs a way
 * to put them there. Two shapes, one endpoint:
 *
 *   { userId }               someone who already exists (a friend, or another
 *                            member of a group you share)
 *   { firstName, lastName? } a new PLACEHOLDER person, created here as a ghost
 *
 * Re-adding someone who left flips `left_at` back rather than inserting, so
 * their history in the group stays attached and no balance moves.
 */
groupRoutes.post(
  "/:id/members",
  zValidator(
    "json",
    z.union([
      z.object({ userId: ulidSchema }),
      z.object({
        firstName: z.string().min(1).max(100),
        lastName: z.string().max(100).optional(),
      }),
    ]),
  ),
  async (c) => {
    const auth = c.get("user");
    const groupId = c.req.param("id");
    if (!isUlid(groupId)) return c.json({ error: "Invalid group id" }, 400);

    if (!(await assertMember(groupId, auth.id))) {
      return c.json({ error: "Not a member of this group" }, 403);
    }

    const input = c.req.valid("json");

    const userId =
      "userId" in input
        ? input.userId
        : await transaction(async (trx) => {
            const created = await trx
              .insertInto("users")
              .values({
                id: ulid(),
                first_name: input.firstName,
                last_name: input.lastName ?? null,
                default_currency: (
                  await trx
                    .selectFrom("groups")
                    .select("default_currency")
                    .where("id", "=", groupId)
                    .executeTakeFirstOrThrow()
                ).default_currency,
                is_ghost: 1,
              })
              .returning("id")
              .executeTakeFirstOrThrow();
            return created.id;
          });

    if ("userId" in input) {
      // You may only pull in someone you can already see. Otherwise this is a
      // way to attach a stranger's account to your ledger by guessing a ULID.
      const visible = new Set(await listRelatedUserIds(db, auth.id));
      if (userId !== auth.id && !visible.has(userId)) {
        return c.json({ error: "You can only add people you already share history with." }, 400);
      }

      const target = await db
        .selectFrom("users")
        .select("id")
        .where("id", "=", userId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!target) return c.json({ error: "That person does not exist" }, 404);
    }

    const existing = await db
      .selectFrom("group_members")
      .select(["user_id", "left_at"])
      .where("group_id", "=", groupId)
      .where("user_id", "=", userId)
      .executeTakeFirst();

    if (existing) {
      if (existing.left_at === null) return c.json({ error: "Already a member" }, 409);
      await db
        .updateTable("group_members")
        .set({ left_at: null })
        .where("group_id", "=", groupId)
        .where("user_id", "=", userId)
        .execute();
    } else {
      await db
        .insertInto("group_members")
        .values({ group_id: groupId, user_id: userId, role: "member", joined_via: "added" })
        .execute();
    }

    const member = await db
      .selectFrom("users")
      .select(["id", "first_name", "last_name", "is_ghost"])
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();

    return c.json({ member: { ...member, role: "member", joined_via: "added" } }, 201);
  },
);

/**
 * Removes someone from a group.
 *
 * A soft removal (`left_at`), never a delete: the expenses they are on are
 * still real and still owed. Their per-member guest link dies with the
 * membership, because a revocation that leaves a working door open is not one.
 * The group's general link is deliberately left alone; switching that off is a
 * separate decision. See docs/GUEST.md.
 */
groupRoutes.delete("/:id/members/:userId", async (c) => {
  const auth = c.get("user");
  const groupId = c.req.param("id");
  const userId = c.req.param("userId");
  if (!isUlid(groupId) || !isUlid(userId)) return c.json({ error: "Invalid id" }, 400);

  const membership = await assertMember(groupId, auth.id);
  if (!membership) return c.json({ error: "Not a member of this group" }, 403);
  if (membership.role !== "owner" && userId !== auth.id) {
    return c.json({ error: "Only the group owner can remove other people" }, 403);
  }

  const owners = await db
    .selectFrom("group_members")
    .select("user_id")
    .where("group_id", "=", groupId)
    .where("role", "=", "owner")
    .where("left_at", "is", null)
    .execute();

  if (owners.length === 1 && owners[0]!.user_id === userId) {
    return c.json({ error: "A group needs an owner. Make someone else the owner first." }, 400);
  }

  await transaction(async (trx) => {
    await trx
      .updateTable("group_members")
      .set({ left_at: new Date().toISOString() })
      .where("group_id", "=", groupId)
      .where("user_id", "=", userId)
      .where("left_at", "is", null)
      .execute();

    await revokeMemberLinks(trx, groupId, userId);
  });

  return c.json({ ok: true });
});

groupRoutes.post(
  "/:id/payments",
  zValidator(
    "json",
    z.object({
      fromUserId: ulidSchema,
      toUserId: ulidSchema,
      amountMinor: z.number().int().positive(),
      currencyCode: z.string().length(3).toUpperCase(),
      date: z.string().optional(),
    }),
  ),
  async (c) => {
    const auth = c.get("user");
    const groupId = c.req.param("id");
    if (!isUlid(groupId)) return c.json({ error: "Invalid group id" }, 400);

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
 * The group-scoped and friend-scoped endpoints stay as they are; they are what
 * the compat layer and existing clients use, but neither can express the one
 * shape the add-expense dialog needs: several people, chosen freely, possibly
 * with no group. This is that endpoint, and it is the one the web UI posts to.
 *
 * Who may appear on the expense:
 *
 *   in a group: its current members, enforced by createExpense itself
 *   no group   (you, plus anyone you already share money history with
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

  const byExpense = new Map<string, typeof shares>();
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
 * Backs the "Popular" section of the currency picker: a static top-10 list is
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

/** Throws a 404-shaped result unless the caller is on this expense. */
async function assertParticipant(expenseId: string, userId: string) {
  return db
    .selectFrom("expense_users")
    .select("user_id")
    .where("expense_id", "=", expenseId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
}

/**
 * One expense in full: every share, plus each one's `split_input` so the edit
 * form can reopen the split exactly as it was entered rather than re-deriving
 * it from the stored amounts.
 */
expenseRoutes.get("/:id", async (c) => {
  const auth = c.get("user");
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  if (!(await assertParticipant(expenseId, auth.id))) return c.json({ error: "Not found" }, 404);

  const expense = await db
    .selectFrom("expenses")
    .leftJoin("categories", "categories.id", "expenses.category_id")
    .leftJoin("groups", "groups.id", "expenses.group_id")
    .select([
      "expenses.id", "expenses.description", "expenses.details", "expenses.cost_minor",
      "expenses.currency_code", "expenses.date", "expenses.is_payment",
      "expenses.split_type", "expenses.split_meta", "expenses.category_id", "expenses.group_id",
      "categories.name as category_name", "groups.name as group_name",
    ])
    .where("expenses.id", "=", expenseId)
    .where("expenses.deleted_at", "is", null)
    .executeTakeFirst();

  if (!expense) return c.json({ error: "Not found" }, 404);

  const shares = await db
    .selectFrom("expense_users")
    .select(["user_id", "paid_share_minor", "owed_share_minor", "split_input"])
    .where("expense_id", "=", expenseId)
    .execute();

  return c.json({ expense: { ...expense, shares } });
});

/** Replaces an expense's contents via the domain layer's updateExpense. */
expenseRoutes.patch("/:id", zValidator("json", genericExpenseBodySchema), async (c) => {
  const auth = c.get("user");
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  if (!(await assertParticipant(expenseId, auth.id))) return c.json({ error: "Not found" }, 404);

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
    await updateExpense(expenseId, {
      ...input,
      groupId,
      details: input.details ?? null,
      categoryId: input.categoryId ?? null,
      updatedBy: auth.id,
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not update expense" }, 400);
  }
});

expenseRoutes.delete("/:id", async (c) => {
  const auth = c.get("user");
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  // Only a participant may delete an expense.
  if (!(await assertParticipant(expenseId, auth.id))) return c.json({ error: "Not found" }, 404);

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
