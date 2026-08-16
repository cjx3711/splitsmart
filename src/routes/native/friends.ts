/**
 * Native friend routes.
 *
 * A "friend" here is anyone you share money history with — see
 * src/domain/friends.ts for the explicit-vs-derived distinction. These routes
 * expose the explicit half (add, remove) plus the one-on-one expenses that only
 * make sense outside a group.
 *
 * ADDING A FRIEND CREATES A GHOST. There is no pending-invitation table and no
 * placeholder record: the person you add is a real row in `users` from the
 * start, so an expense can name them immediately. If they later accept, the
 * ghost is upgraded in place by POST /invite/claim and no balance moves.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db, transaction } from "../../db/index.ts";
import { env } from "../../env.ts";
import { generateRecoveryCode, normaliseRecoveryCode, hashPassword } from "../../auth/password.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import {
  getPairwiseBalances,
  getPairwiseBalancesByGroup,
  getBalanceBetween,
  type CurrencyAmount,
} from "../../domain/balances.ts";
import {
  addFriendship,
  removeFriendship,
  listExplicitFriendIds,
  listRelatedUserIds,
} from "../../domain/friends.ts";
import { createExpense, createPayment } from "../../domain/expenses.ts";
import { sendEmail } from "../../email/postmark.ts";
import { friendInviteEmail } from "../../email/templates.ts";

export const friendRoutes = new Hono<AppEnv>();
friendRoutes.use("*", requireAuth);

interface FriendBreakdown {
  groupId: number | null;
  groupName: string | null;
  balances: CurrencyAmount[];
}

/**
 * Labels each pairwise bucket with its group name.
 *
 * A NULL group_id is the one-on-one bucket. It is given a null name rather than
 * a made-up one so the UI decides the wording ("Non-group expenses") in one
 * place instead of the server inventing a pseudo-group.
 */
async function breakdownByUser(
  userId: number,
): Promise<Map<number, FriendBreakdown[]>> {
  const rows = await getPairwiseBalancesByGroup(db, userId);

  const groupIds = [...new Set(rows.map((r) => r.groupId).filter((id): id is number => id !== null))];
  const groups = groupIds.length
    ? await db.selectFrom("groups").select(["id", "name"]).where("id", "in", groupIds).execute()
    : [];
  const nameById = new Map(groups.map((g) => [g.id, g.name]));

  const byUser = new Map<number, FriendBreakdown[]>();
  for (const row of rows) {
    const list = byUser.get(row.otherUserId) ?? [];
    list.push({
      groupId: row.groupId,
      groupName: row.groupId === null ? null : (nameById.get(row.groupId) ?? null),
      balances: row.balances,
    });
    byUser.set(row.otherUserId, list);
  }
  return byUser;
}

friendRoutes.get("/", async (c) => {
  const auth = c.get("user");

  const ids = await listRelatedUserIds(db, auth.id);
  if (ids.length === 0) return c.json({ friends: [] });

  const [users, balances, explicitIds, breakdowns] = await Promise.all([
    db
      .selectFrom("users")
      .select(["id", "email", "first_name", "last_name", "is_ghost", "default_currency"])
      .where("id", "in", ids)
      .where("deleted_at", "is", null)
      .orderBy("first_name")
      .execute(),
    getPairwiseBalances(db, auth.id),
    listExplicitFriendIds(db, auth.id),
    breakdownByUser(auth.id),
  ]);

  const balanceByUser = new Map(balances.map((b) => [b.otherUserId, b.balances]));
  const explicit = new Set(explicitIds);

  return c.json({
    friends: users.map((u) => ({
      id: u.id,
      email: u.email,
      first_name: u.first_name,
      last_name: u.last_name,
      is_ghost: u.is_ghost,
      // Only explicit friendships can be removed; the rest come from shared
      // groups and expenses and would reappear on the next page load.
      is_explicit: explicit.has(u.id),
      balances: balanceByUser.get(u.id) ?? [],
      breakdown: breakdowns.get(u.id) ?? [],
    })),
  });
});

const addFriendSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().max(100).optional(),
  // Optional on purpose: adding someone by name alone is a legitimate way to
  // track what they owe you without ever contacting them.
  email: z
    .string()
    .email()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

friendRoutes.post("/", zValidator("json", addFriendSchema), async (c) => {
  const auth = c.get("user");
  const input = c.req.valid("json");

  if (auth.isGhost) {
    return c.json({ error: "Guest accounts cannot add friends." }, 403);
  }

  const existing = input.email
    ? await db
        .selectFrom("users")
        .select(["id", "email", "first_name", "last_name", "is_ghost"])
        .where("email", "=", input.email)
        .where("deleted_at", "is", null)
        .executeTakeFirst()
    : undefined;

  if (existing?.id === auth.id) {
    return c.json({ error: "That's your own email address." }, 400);
  }

  // Someone with that address already has an account: link to them rather than
  // creating a duplicate person. Their name is theirs, not whatever was typed.
  if (existing) {
    await addFriendship(db, auth.id, existing.id);

    const invite = friendInviteEmail({
      firstName: existing.first_name,
      inviterName: auth.firstName,
      acceptUrl: env.APP_ORIGIN,
      isNewAccount: false,
    });
    const delivery = existing.email ? await sendEmail({ to: existing.email, ...invite }) : null;

    return c.json(
      {
        friend: {
          id: existing.id,
          email: existing.email,
          first_name: existing.first_name,
          last_name: existing.last_name,
          is_ghost: existing.is_ghost,
          is_explicit: 1,
          balances: await getBalanceBetween(db, auth.id, existing.id),
          breakdown: [],
        },
        existingAccount: true,
        emailDelivered: delivery?.delivered ?? false,
      },
      201,
    );
  }

  // Every new friend gets a recovery code, whether or not we can email it. It
  // is the only route back into a ghost account, and generating it lazily later
  // is impossible — the hash is all we keep.
  const recoveryCode = generateRecoveryCode();

  const friend = await transaction(async (trx) => {
    return trx
      .insertInto("users")
      .values({
        first_name: input.firstName,
        last_name: input.lastName ?? null,
        // A ghost may carry an address it has not proved control of. Login
        // still refuses ghosts, and issueVerificationToken skips them, so this
        // never turns into an unverified-but-usable login.
        email: input.email ?? null,
        default_currency: auth.defaultCurrency,
        is_ghost: 1,
        recovery_code_hash: await hashPassword(normaliseRecoveryCode(recoveryCode)),
      })
      .returning(["id", "email", "first_name", "last_name", "is_ghost"])
      .executeTakeFirstOrThrow();
  });

  await addFriendship(db, auth.id, friend.id);

  let emailDelivered = false;
  if (input.email) {
    const invite = friendInviteEmail({
      firstName: friend.first_name,
      inviterName: auth.firstName,
      acceptUrl: `${env.APP_ORIGIN}/accept/${recoveryCode}`,
      isNewAccount: true,
    });
    const delivery = await sendEmail({ to: input.email, ...invite });
    emailDelivered = delivery.delivered;
  }

  return c.json(
    {
      friend: { ...friend, is_explicit: 1, balances: [], breakdown: [] },
      existingAccount: false,
      emailDelivered,
      // Shown once. With no email configured this is the only way to hand the
      // account over, so the UI must surface it rather than discard it.
      recoveryCode,
    },
    201,
  );
});

friendRoutes.get("/:id", async (c) => {
  const auth = c.get("user");
  const friendId = Number(c.req.param("id"));
  if (!Number.isInteger(friendId)) return c.json({ error: "Invalid friend id" }, 400);

  const related = await listRelatedUserIds(db, auth.id);
  if (!related.includes(friendId)) return c.json({ error: "Friend not found" }, 404);

  const friend = await db
    .selectFrom("users")
    .select(["id", "email", "first_name", "last_name", "is_ghost", "default_currency"])
    .where("id", "=", friendId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  if (!friend) return c.json({ error: "Friend not found" }, 404);

  const [balances, explicitIds, breakdowns] = await Promise.all([
    getBalanceBetween(db, auth.id, friendId),
    listExplicitFriendIds(db, auth.id),
    breakdownByUser(auth.id),
  ]);

  return c.json({
    friend: {
      ...friend,
      is_explicit: explicitIds.includes(friendId),
      balances,
      breakdown: breakdowns.get(friendId) ?? [],
    },
  });
});

/**
 * Expenses shared with one friend, across every group plus the one-on-one ones.
 *
 * Matching the friend screen in Splitwise: the question "what is between us"
 * does not stop at a group boundary.
 */
friendRoutes.get("/:id/expenses", async (c) => {
  const auth = c.get("user");
  const friendId = Number(c.req.param("id"));
  if (!Number.isInteger(friendId)) return c.json({ error: "Invalid friend id" }, 400);

  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);

  const expenses = await db
    .selectFrom("expenses")
    .leftJoin("categories", "categories.id", "expenses.category_id")
    .leftJoin("groups", "groups.id", "expenses.group_id")
    .select([
      "expenses.id", "expenses.description", "expenses.cost_minor",
      "expenses.currency_code", "expenses.date", "expenses.is_payment",
      "expenses.split_type", "expenses.group_id",
      "categories.name as category_name", "groups.name as group_name",
    ])
    .where("expenses.deleted_at", "is", null)
    // Both of us on the same expense. Two EXISTS rather than a self-join so the
    // per-user index is used twice instead of scanning the pair table.
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom("expense_users")
          .select("expense_users.user_id")
          .whereRef("expense_users.expense_id", "=", "expenses.id")
          .where("expense_users.user_id", "=", auth.id),
      ),
    )
    .where(({ exists, selectFrom }) =>
      exists(
        selectFrom("expense_users")
          .select("expense_users.user_id")
          .whereRef("expense_users.expense_id", "=", "expenses.id")
          .where("expense_users.user_id", "=", friendId),
      ),
    )
    .orderBy("expenses.date", "desc")
    .orderBy("expenses.id", "desc")
    .limit(limit)
    .execute();

  if (expenses.length === 0) return c.json({ expenses: [] });

  const shares = await db
    .selectFrom("expense_users")
    .select(["expense_id", "user_id", "paid_share_minor", "owed_share_minor"])
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

const participantSchema = z.object({
  userId: z.number().int().positive(),
  paidMinor: z.number().int().min(0),
  input: z.number().optional(),
});

/**
 * A one-on-one expense: group_id stays NULL.
 *
 * createExpense skips its membership check when there is no group, so the
 * "who is allowed to be on this" rule has to be enforced here. It is
 * deliberately the strictest possible version — exactly the two of you — since
 * a wider set has no screen that can display it.
 */
friendRoutes.post(
  "/:id/expenses",
  zValidator(
    "json",
    z.object({
      description: z.string().min(1).max(500),
      details: z.string().max(5000).optional(),
      costMinor: z.number().int().min(0),
      currencyCode: z.string().length(3).toUpperCase(),
      date: z.string(),
      categoryId: z.number().int().positive().nullable().optional(),
      splitType: z.enum(["equal", "exact", "percent", "shares", "adjustment"]),
      participants: z.array(participantSchema).min(1).max(2),
    }),
  ),
  async (c) => {
    const auth = c.get("user");
    const friendId = Number(c.req.param("id"));
    if (!Number.isInteger(friendId)) return c.json({ error: "Invalid friend id" }, 400);

    const related = await listRelatedUserIds(db, auth.id);
    if (!related.includes(friendId)) return c.json({ error: "Friend not found" }, 404);

    const input = c.req.valid("json");
    const allowed = new Set([auth.id, friendId]);
    if (input.participants.some((p) => !allowed.has(p.userId))) {
      return c.json({ error: "A one-on-one expense can only involve the two of you." }, 400);
    }

    try {
      const expenseId = await createExpense({
        ...input,
        groupId: null,
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

/** Settling up with a friend outside any group. */
friendRoutes.post(
  "/:id/payments",
  zValidator(
    "json",
    z.object({
      direction: z.enum(["you_paid", "they_paid"]),
      amountMinor: z.number().int().positive(),
      currencyCode: z.string().length(3).toUpperCase(),
      date: z.string().optional(),
    }),
  ),
  async (c) => {
    const auth = c.get("user");
    const friendId = Number(c.req.param("id"));
    if (!Number.isInteger(friendId)) return c.json({ error: "Invalid friend id" }, 400);

    const related = await listRelatedUserIds(db, auth.id);
    if (!related.includes(friendId)) return c.json({ error: "Friend not found" }, 404);

    const input = c.req.valid("json");

    try {
      const id = await createPayment({
        groupId: null,
        fromUserId: input.direction === "you_paid" ? auth.id : friendId,
        toUserId: input.direction === "you_paid" ? friendId : auth.id,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        date: input.date,
        createdBy: auth.id,
      });
      return c.json({ id }, 201);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Could not record payment" },
        400,
      );
    }
  },
);

/**
 * Removes the explicit friendship only.
 *
 * Nothing financial is touched — no expense is deleted and no balance moves. If
 * you still share a group or an expense they stay in your list as a derived
 * friend, which is correct: you cannot un-owe someone by unfriending them.
 */
friendRoutes.delete("/:id", async (c) => {
  const auth = c.get("user");
  const friendId = Number(c.req.param("id"));
  if (!Number.isInteger(friendId)) return c.json({ error: "Invalid friend id" }, 400);

  await removeFriendship(db, auth.id, friendId);

  const stillVisible = (await listRelatedUserIds(db, auth.id)).includes(friendId);
  return c.json({ ok: true, stillVisible });
});
