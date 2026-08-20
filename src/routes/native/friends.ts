/**
 * Native friend routes.
 *
 * A "friend" here is anyone you share money history with. See
 * src/domain/friends.ts for the explicit-vs-derived distinction. These routes
 * expose the explicit half (add, remove) plus the one-on-one expenses that only
 * make sense outside a group.
 *
 * ADDING A FRIEND CREATES A GHOST. There is no pending-invitation table and no
 * placeholder record: the person you add is a real row in `users` from the
 * start, so an expense can name them immediately. If they later take the
 * account over, that is a CLAIM: they register, then merge the ghost into their
 * new account (src/routes/native/claim.ts). No balance moves either way.
 *
 * An invite address is stored in `invite_email`, not `users.email`. Occupying
 * the login unique index would let anyone squat an inbox by adding a friend.
 *
 * The invite is a guest link (`/guest/l/<secret>`), not a recovery code. It is
 * revocable, it expires if the owner says so, and it needs no transcription.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db, transaction } from "../../db/index.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import {
  getPairwiseBalances,
  getPairwiseBalancesByGroup,
  getBalanceBetween,
  type CurrencyAmount,
} from "../../domain/balances.ts";
import { compareByLastExpense } from "../../domain/friend-recency.ts";
import {
  addFriendship,
  findExplicitGhostByInviteEmail,
  lastSharedExpenseIds,
  removeFriendship,
  listExplicitFriendIds,
  listRelatedUserIds,
} from "../../domain/friends.ts";
import { createExpense, createPayment } from "../../domain/expenses.ts";
import { commentCountSql } from "../../domain/comments.ts";
import { findFriendLink, mintAccessLink } from "../../domain/access-links.ts";
import { expenseBodySchema } from "./expense-schema.ts";
import { expenseFilterWhere, expenseListQuerySchema, hasFilters, parseExpenseFilters } from "./expense-filters.ts";
import { sendEmail } from "../../email/postmark.ts";
import { friendInviteEmail } from "../../email/templates.ts";
import { env } from "../../env.ts";
import { displayName, knownEmail, MAX_NAME_LENGTH, personSnake } from "../../domain/person.ts";
import { isUlid, ulid } from "../../domain/ulid.ts";
import { logChange } from "../../domain/sync-log.ts";
import {
  hasIdentityPatch,
  identityColumns,
  identityPatchSchema,
} from "./person-schema.ts";

interface FriendBreakdown {
  groupId: string | null;
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
  userId: string,
): Promise<Map<string, FriendBreakdown[]>> {
  const rows = await getPairwiseBalancesByGroup(db, userId);

  const groupIds = [...new Set(rows.map((r) => r.groupId).filter((id): id is string => id !== null))];
  const groups = groupIds.length
    ? await db.selectFrom("groups").select(["id", "name"]).where("id", "in", groupIds).execute()
    : [];
  const nameById = new Map(groups.map((g) => [g.id, g.name]));

  const byUser = new Map<string, FriendBreakdown[]>();
  for (const row of rows) {
    const list = byUser.get(row.otherUserId) ?? [];
    list.push({
      groupId: row.groupId,
      groupName: row.groupId === null ? null : (nameById.get(row.groupId) ?? null),
      balances: row.balances,
    });
    byUser.set(row.otherUserId, list);
  }
  for (const list of byUser.values()) {
    list.sort(byGroupName);
  }
  return byUser;
}

function byGroupName(a: { groupName: string | null }, b: { groupName: string | null }): number {
  if (a.groupName === b.groupName) return 0;
  if (a.groupName === null) return 1;
  if (b.groupName === null) return -1;
  return a.groupName.localeCompare(b.groupName);
}

const addFriendSchema = z.object({
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  // Optional on purpose: adding someone by name alone is a legitimate way to
  // track what they owe you without ever contacting them.
  email: z
    .string()
    .email()
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export const friendRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/", async (c) => {
  const auth = c.get("user");

  const ids = await listRelatedUserIds(db, auth.id);
  if (ids.length === 0) return c.json({ friends: [] });

  const [users, balances, explicitIds, breakdowns, lastByUser] = await Promise.all([
    db
      .selectFrom("users")
      .select([
        "id",
        "email",
        "invite_email",
        "name",
        "nickname",
        "icon_letters",
        "icon_emoji",
        "icon_hue",
        "is_ghost",
        "default_currency",
      ])
      .where("id", "in", ids)
      .where("deleted_at", "is", null)
      .execute(),
    getPairwiseBalances(db, auth.id),
    listExplicitFriendIds(db, auth.id),
    breakdownByUser(auth.id),
    lastSharedExpenseIds(db, auth.id),
  ]);

  users.sort((a, b) =>
    compareByLastExpense(a.id, b.id, lastByUser, displayName(a), displayName(b)),
  );

  const balanceByUser = new Map(balances.map((b) => [b.otherUserId, b.balances]));
  const explicit = new Set(explicitIds);

  return c.json({
    friends: users.map((u) => ({
        id: u.id,
        email: knownEmail(u),
      ...personSnake(u),
      is_ghost: u.is_ghost,
      // Only explicit friendships can be removed; the rest come from shared
      // groups and expenses and would reappear on the next page load.
      is_explicit: explicit.has(u.id),
      balances: balanceByUser.get(u.id) ?? [],
      breakdown: breakdowns.get(u.id) ?? [],
    })),
  });
})
  .post("/", zValidator("json", addFriendSchema), async (c) => {
  const auth = c.get("user");
  const input = c.req.valid("json");

  if (auth.isGhost) {
    return c.json({ error: "Guest accounts cannot add friends." }, 403);
  }

  const existingAccount = input.email
    ? await db
        .selectFrom("users")
        .select([
          "id",
          "email",
          "invite_email",
          "name",
          "nickname",
          "icon_letters",
          "icon_emoji",
          "icon_hue",
          "is_ghost",
        ])
        .where("email", "=", input.email)
        .where("is_ghost", "=", 0)
        .where("deleted_at", "is", null)
        .executeTakeFirst()
    : undefined;

  if (existingAccount?.id === auth.id) {
    return c.json({ error: "That's your own email address." }, 400);
  }

  // Someone with that address already has an account: link to them rather than
  // creating a duplicate person. Their name is theirs, not whatever was typed.
  if (existingAccount) {
    await addFriendship(auth.id, existingAccount.id);

    const invite = friendInviteEmail({
      name: displayName(existingAccount),
      inviterName: displayName(auth),
      // They already have an account, so the invite is just the front door.
      acceptUrl: `${env.APP_ORIGIN}/app`,
      isNewAccount: false,
    });
    const delivery = existingAccount.email
      ? await sendEmail({ to: existingAccount.email, ...invite })
      : null;

    return c.json(
      {
        friend: {
          id: existingAccount.id,
          email: knownEmail(existingAccount),
          ...personSnake(existingAccount),
          is_ghost: existingAccount.is_ghost,
          is_explicit: 1,
          balances: await getBalanceBetween(db, auth.id, existingAccount.id),
          breakdown: [],
        },
        existingAccount: true,
        emailDelivered: delivery?.delivered ?? false,
      },
      201,
    );
  }

  // This owner's existing placeholder at that address, not anyone else's.
  // Unique per owner: two people can invite the same inbox, and that inbox
  // can still register because invite_email is not users.email.
  if (input.email) {
    const existingGhost = await findExplicitGhostByInviteEmail(db, auth.id, input.email);
    if (existingGhost) {
      await addFriendship(auth.id, existingGhost.id);

      let inviteUrl =
        (await findFriendLink(db, auth.id, existingGhost.id))?.url ?? undefined;
      if (!inviteUrl) {
        const minted = await transaction((trx) =>
          mintAccessLink(trx, {
            kind: "friend",
            userId: existingGhost.id,
            createdBy: auth.id,
          }),
        );
        inviteUrl = minted.url;
      }

      const invite = friendInviteEmail({
        name: displayName(existingGhost),
        inviterName: displayName(auth),
        acceptUrl: inviteUrl,
        isNewAccount: true,
      });
      const delivery = await sendEmail({ to: input.email, ...invite });

      return c.json(
        {
          friend: {
            id: existingGhost.id,
            email: knownEmail(existingGhost),
            ...personSnake(existingGhost),
            is_ghost: existingGhost.is_ghost,
            is_explicit: 1,
            balances: await getBalanceBetween(db, auth.id, existingGhost.id),
            breakdown: [],
          },
          existingAccount: false,
          emailDelivered: delivery.delivered,
          inviteUrl,
        },
        201,
      );
    }
  }

  // A placeholder person plus the guest link that reaches them, minted
  // together so the address we invite them at always has somewhere to go.
  const { friend, inviteUrl } = await transaction(async (trx) => {
    const created = await trx
      .insertInto("users")
      .values({
        id: ulid(),
        name: input.name,
        // Stored off the login unique index on purpose: occupying users.email
        // would let anyone squat an inbox by adding a friend.
        invite_email: input.email ?? null,
        default_currency: auth.defaultCurrency,
        is_ghost: 1,
      })
      .returning([
        "id",
        "email",
        "invite_email",
        "name",
        "nickname",
        "icon_letters",
        "icon_emoji",
        "icon_hue",
        "is_ghost",
      ])
      .executeTakeFirstOrThrow();

    const link = await mintAccessLink(trx, {
      kind: "friend",
      userId: created.id,
      createdBy: auth.id,
    });

    return { friend: created, inviteUrl: link.url };
  });

  await addFriendship(auth.id, friend.id);

  let emailDelivered = false;
  if (input.email) {
    const invite = friendInviteEmail({
      name: displayName(friend),
      inviterName: displayName(auth),
      acceptUrl: inviteUrl,
      isNewAccount: true,
    });
    const delivery = await sendEmail({ to: input.email, ...invite });
    emailDelivered = delivery.delivered;
  }

  return c.json(
    {
      friend: {
        id: friend.id,
        email: knownEmail(friend),
        ...personSnake(friend),
        is_ghost: friend.is_ghost,
        is_explicit: 1,
        balances: [],
        breakdown: [],
      },
      existingAccount: false,
      emailDelivered,
      // Returned so the UI can copy it. The same URL is always available from
      // the friend's guest-link panel.
      inviteUrl,
    },
    201,
  );
})
  .get("/:id", async (c) => {
  const auth = c.get("user");
  const friendId = c.req.param("id");
  if (!isUlid(friendId)) return c.json({ error: "Invalid friend id" }, 400);

  const related = await listRelatedUserIds(db, auth.id);
  if (!related.includes(friendId)) return c.json({ error: "Friend not found" }, 404);

  const friend = await db
    .selectFrom("users")
    .select([
      "id",
      "email",
      "invite_email",
      "name",
      "nickname",
      "icon_letters",
      "icon_emoji",
      "icon_hue",
      "is_ghost",
      "default_currency",
    ])
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
      id: friend.id,
      email: knownEmail(friend),
      ...personSnake(friend),
      is_ghost: friend.is_ghost,
      is_explicit: explicitIds.includes(friendId),
      balances,
      breakdown: breakdowns.get(friendId) ?? [],
    },
  });
})
/**
 * Edit a placeholder person's name and icon.
 *
 * Real accounts edit themselves at PATCH /auth/me. A ghost has no login, so
 * the people who can already see them (friends, group-mates) may set the
 * name, nickname, and icon they all share. Fan-out is via audience-addressed
 * `user` log rows: a standalone `user` row otherwise only reaches its own
 * subject, and ghosts do not sync.
 */
  .patch(
  "/:id",
  zValidator("json", identityPatchSchema),
  async (c) => {
    const auth = c.get("user");
    const friendId = c.req.param("id");
    if (!isUlid(friendId)) return c.json({ error: "Invalid friend id" }, 400);

    const input = c.req.valid("json");
    if (!hasIdentityPatch(input)) {
      return c.json({ error: "Nothing to update." }, 400);
    }

    const related = await listRelatedUserIds(db, auth.id);
    if (!related.includes(friendId)) return c.json({ error: "Friend not found" }, 404);

    const friend = await db
      .selectFrom("users")
      .select(["id", "is_ghost"])
      .where("id", "=", friendId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (!friend) return c.json({ error: "Friend not found" }, 404);
    if (friend.is_ghost !== 1) {
      return c.json(
        { error: "You can only edit placeholder people. They change their own name after they join." },
        403,
      );
    }

    const identity = identityColumns(input);
    const audience = await listRelatedUserIds(db, friendId);

    const updated = await transaction(async (trx) => {
      const row = await trx
        .updateTable("users")
        .set({
          ...identity,
          updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
        })
        .where("id", "=", friendId)
        .returning([
          "id",
          "email",
          "invite_email",
          "name",
          "nickname",
          "icon_letters",
          "icon_emoji",
          "icon_hue",
          "is_ghost",
          "default_currency",
        ])
        .executeTakeFirstOrThrow();

      await logChange(
        trx,
        ...audience.map((id) => ({
          entity: "user" as const,
          entityId: friendId,
          op: "upsert" as const,
          actorUserId: auth.id,
          audienceUserId: id,
        })),
      );

      return row;
    });

    const [balances, explicitIds, breakdowns] = await Promise.all([
      getBalanceBetween(db, auth.id, friendId),
      listExplicitFriendIds(db, auth.id),
      breakdownByUser(auth.id),
    ]);

    return c.json({
      friend: {
        id: updated.id,
        email: knownEmail(updated),
        ...personSnake(updated),
        is_ghost: updated.is_ghost,
        is_explicit: explicitIds.includes(friendId),
        balances,
        breakdown: breakdowns.get(friendId) ?? [],
      },
    });
  },
)
/**
 * Expenses shared with one friend, across every group plus the one-on-one ones.
 *
 * Matching the friend screen in Splitwise: the question "what is between us"
 * does not stop at a group boundary.
 */
  .get("/:id/expenses", zValidator("query", expenseListQuerySchema), async (c) => {
  const auth = c.get("user");
  const friendId = c.req.param("id");
  if (!isUlid(friendId)) return c.json({ error: "Invalid friend id" }, 400);

  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
  const filters = parseExpenseFilters(c.req.query());

  let query = db
    .selectFrom("expenses")
    .leftJoin("categories", "categories.id", "expenses.category_id")
    .leftJoin("groups", "groups.id", "expenses.group_id")
    .select([
      "expenses.id", "expenses.description", "expenses.cost_minor",
      "expenses.currency_code", "expenses.date", "expenses.is_payment",
      "expenses.split_type", "expenses.split_meta", "expenses.group_id",
      "expenses.repeat_interval", "expenses.repeat_of",
      "categories.name as category_name", "groups.name as group_name",
    ])
    .select(commentCountSql().as("comment_count"))
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
    .limit(limit);

  if (hasFilters(filters)) query = query.where(expenseFilterWhere(filters));

  const expenses = await query.execute();

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
})
/**
 * A one-on-one expense: group_id stays NULL.
 *
 * createExpense skips its membership check when there is no group, so the
 * "who is allowed to be on this" rule has to be enforced here. It is
 * deliberately the strictest possible version: exactly the two of you, since
 * a wider set has no screen that can display it.
 */
  .post(
  "/:id/expenses",
  zValidator("json", expenseBodySchema),
  async (c) => {
    const auth = c.get("user");
    const friendId = c.req.param("id");
    if (!isUlid(friendId)) return c.json({ error: "Invalid friend id" }, 400);

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
)
/** Settling up with a friend outside any group. */
  .post(
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
    const friendId = c.req.param("id");
    if (!isUlid(friendId)) return c.json({ error: "Invalid friend id" }, 400);

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
)
/**
 * Removes the explicit friendship only.
 *
 * Nothing financial is touched; no expense is deleted and no balance moves. If
 * you still share a group or an expense they stay in your list as a derived
 * friend, which is correct: you cannot un-owe someone by unfriending them.
 */
  .delete("/:id", async (c) => {
  const auth = c.get("user");
  const friendId = c.req.param("id");
  if (!isUlid(friendId)) return c.json({ error: "Invalid friend id" }, 400);

  await removeFriendship(auth.id, friendId);

  const stillVisible = (await listRelatedUserIds(db, auth.id)).includes(friendId);
  return c.json({ ok: true, stillVisible });
});
