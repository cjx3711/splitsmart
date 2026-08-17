/**
 * The guest API, mounted at /api/v1/guest.
 *
 * Everything the guest shell (`/guest/*`) talks to is here, and NOTHING here
 * accepts a cookie or an API token. The caller proves who they are with
 *
 *     Authorization: Bearer link_<secret>
 *
 * on every single request, which is re-resolved every single time. That is what
 * makes revocation instant, and it is also why the guest app is never allowed
 * to work offline: a link can be taken away, a cached ledger cannot.
 *
 * SCOPE IS ENFORCED IN EVERY HANDLER, not once at the door. `guestAuth` below
 * builds a `GuestScope` (which groups, which person, which counterpart) and
 * each route filters against it. The two rules that matter, from docs/GUEST.md:
 *
 *   a group link for Alice in group A never returns group B
 *   a group link never returns a 1:1 expense Alice is on
 *
 * Both fall out of `expenseInScope` in src/domain/access-links.ts, which is the
 * one place that decides visibility. Do not hand-roll the predicate at a call
 * site; there are four read paths here and they must agree.
 *
 * What a guest may do: add, edit and delete expenses, and settle up. What they
 * may not: group settings, membership, minting or revoking links, adding
 * people, API tokens, import, creating groups or friends. There is deliberately
 * no route for any of that in this file.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { db } from "../../db/index.ts";
import {
  resolveAccessLink,
  resolveActingAs,
  listActablePeople,
  buildScope,
  expenseInScope,
  writablePeople,
  failureMessage,
  isLinkToken,
  LINK_TOKEN_PREFIX,
  type AccessLinkRecord,
  type GuestScope,
} from "../../domain/access-links.ts";
import { getGroupBalances, getBalanceBetween, simplifyDebts } from "../../domain/balances.ts";
import {
  createExpense,
  updateExpense,
  deleteExpense,
  createPayment,
} from "../../domain/expenses.ts";
import { genericExpenseBodySchema, ulidSchema } from "./expense-schema.ts";
import { isUlid } from "../../domain/ulid.ts";

/**
 * Which name the holder of a general group link is speaking as.
 *
 * A guest has no session row to keep this in, so the pick travels on every
 * request and is re-validated every time. A header rather than a body field
 * because it applies to GETs too.
 */
export const ACTING_AS_HEADER = "X-SplitSmart-Acting-As";

interface GuestEnv {
  Variables: {
    link: AccessLinkRecord;
    /** Absent when the holder of a general group link has not picked a name. */
    scope: GuestScope | undefined;
  };
}

export const guestRoutes = new Hono<GuestEnv>();

/**
 * Resolves the link, and the name being acted as when there is one.
 *
 * This does NOT insist on a name. A general group link arrives with nobody
 * picked on the very first request, and the shell has to be able to ask
 * `/session` who the candidates are before it can offer a picker. Routes that
 * genuinely need a person call `scopeOf` below.
 */
const guestAuth: MiddlewareHandler<GuestEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "This needs a guest link.", reason: "invalid" }, 401);
  }

  const bearer = header.slice(7).trim();
  if (!isLinkToken(bearer)) {
    return c.json(
      { error: `A guest link starts with ${LINK_TOKEN_PREFIX}.`, reason: "invalid" },
      401,
    );
  }

  const resolved = await resolveAccessLink(bearer);
  if (!resolved.ok) {
    return c.json({ error: failureMessage(resolved.reason), reason: resolved.reason }, 401);
  }

  const link = resolved.link;
  c.set("link", link);

  const acting = await resolveActingAs(db, link, c.req.header(ACTING_AS_HEADER));
  c.set("scope", acting.ok ? await buildScope(db, link, acting.userId) : undefined);

  await next();
};

guestRoutes.use("*", guestAuth);

/**
 * The scope, or a 409 that tells the shell to show the picker.
 *
 * 401 and 409 mean different things here and the client acts on both: 401 is
 * "this link is finished, ask for a new one", 409 is "the link is fine, you
 * just have not said who you are yet". Collapsing them would send a guest who
 * only needs to tap their own name off to beg for a replacement link.
 */
function scopeOf(c: Context<GuestEnv>): GuestScope {
  const scope = c.get("scope");
  if (!scope) {
    throw new HTTPException(409, {
      res: Response.json(
        { error: "Pick who you are in this group first.", needsPicker: true },
        { status: 409 },
      ),
    });
  }
  return scope;
}

// ---------------------------------------------------------------------------
// Session: what this link is, and who it can be
// ---------------------------------------------------------------------------

/**
 * Everything the guest shell needs to boot: what this link is, who it can be,
 * and where the landing page should send the browser once the secret has been
 * stashed and stripped out of the URL.
 *
 * Answers even when nobody has been picked yet. The picker needs the list of
 * names, so a 409 here would leave the shell with nothing to render and no way
 * out of the deadlock.
 */
guestRoutes.get("/session", async (c) => {
  const link = c.get("link");
  const scope = c.get("scope");

  const actable = await listActablePeople(db, link);

  const me = scope
    ? await db
        .selectFrom("users")
        .select(["id", "first_name", "last_name", "default_currency"])
        .where("id", "=", scope.actingAs)
        .executeTakeFirst()
    : null;

  const group = link.groupId
    ? await db
        .selectFrom("groups")
        .select(["id", "name", "group_type", "default_currency"])
        .where("id", "=", link.groupId)
        .where("deleted_at", "is", null)
        .executeTakeFirst()
    : null;

  const counterpart = scope?.counterpartId
    ? await db
        .selectFrom("users")
        .select(["id", "first_name", "last_name"])
        .where("id", "=", scope.counterpartId)
        .executeTakeFirst()
    : null;

  const groups = scope && scope.groupIds.length
    ? await db
        .selectFrom("groups")
        .select(["id", "name", "group_type", "default_currency"])
        .where("id", "in", scope.groupIds)
        .where("deleted_at", "is", null)
        .orderBy("name")
        .execute()
    : [];

  return c.json({
    kind: link.kind,
    /** True when the holder may swap to a different name at any time. */
    canRepick: link.kind === "group",
    /** The shell shows a picker instead of a screen while this is true. */
    needsPicker: !scope,
    expiresAt: link.expiresAt,
    people: actable,
    actingAs: me
      ? {
          id: me.id,
          firstName: me.first_name,
          lastName: me.last_name,
          defaultCurrency: me.default_currency,
        }
      : null,
    group,
    groups,
    counterpart: counterpart
      ? { id: counterpart.id, firstName: counterpart.first_name, lastName: counterpart.last_name }
      : null,
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The ids of every expense inside the scope. One definition, four callers. */
async function visibleExpenseIds(scope: GuestScope): Promise<string[]> {
  const mine = await db
    .selectFrom("expense_users")
    .innerJoin("expenses", "expenses.id", "expense_users.expense_id")
    .select(["expenses.id", "expenses.group_id"])
    .where("expense_users.user_id", "=", scope.actingAs)
    .where("expenses.deleted_at", "is", null)
    .execute();

  const groupIds = new Set(scope.groupIds);
  const candidates = mine.filter((e) =>
    e.group_id === null ? scope.counterpartId !== null : groupIds.has(e.group_id),
  );

  if (candidates.length === 0) return [];

  // The non-group ones still have to have the counterpart on them; a friend
  // link is "you and me", not "everything you ever split with anyone".
  const nonGroupIds = candidates.filter((e) => e.group_id === null).map((e) => e.id);
  const shared = nonGroupIds.length
    ? new Set(
        (
          await db
            .selectFrom("expense_users")
            .select("expense_id")
            .where("expense_id", "in", nonGroupIds)
            .where("user_id", "=", scope.counterpartId!)
            .execute()
        ).map((r) => r.expense_id),
      )
    : new Set<string>();

  return candidates
    .filter((e) => e.group_id !== null || shared.has(e.id))
    .map((e) => e.id);
}

async function loadExpenses(ids: string[], limit: number) {
  if (ids.length === 0) return [];

  const expenses = await db
    .selectFrom("expenses")
    .leftJoin("categories", "categories.id", "expenses.category_id")
    .leftJoin("groups", "groups.id", "expenses.group_id")
    .select([
      "expenses.id", "expenses.description", "expenses.cost_minor",
      "expenses.currency_code", "expenses.date", "expenses.is_payment",
      "expenses.split_type", "expenses.split_meta", "expenses.group_id",
      "categories.name as category_name", "groups.name as group_name",
    ])
    .where("expenses.id", "in", ids)
    .where("expenses.deleted_at", "is", null)
    .orderBy("expenses.date", "desc")
    .orderBy("expenses.id", "desc")
    .limit(limit)
    .execute();

  if (expenses.length === 0) return [];

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

  return expenses.map((e) => ({ ...e, shares: byExpense.get(e.id) ?? [] }));
}

/**
 * Everyone whose name the guest may see.
 *
 * Members of the groups in scope, plus the friend link's counterpart. Not the
 * owner's whole address book: a guest who can read "Dinner, 3 ways" needs the
 * other two names on that bill and nothing else.
 */
async function visiblePeople(scope: GuestScope) {
  const ids = new Set<string>([scope.actingAs]);
  if (scope.counterpartId) ids.add(scope.counterpartId);

  if (scope.groupIds.length > 0) {
    const members = await db
      .selectFrom("group_members")
      .select("user_id")
      .where("group_id", "in", scope.groupIds)
      .where("left_at", "is", null)
      .execute();
    for (const m of members) ids.add(m.user_id);
  }

  const rows = await db
    .selectFrom("users")
    .select(["id", "first_name", "last_name", "is_ghost"])
    .where("id", "in", [...ids])
    .execute();

  return rows;
}

guestRoutes.get("/people", async (c) => {
  return c.json({ people: await visiblePeople(scopeOf(c)) });
});

guestRoutes.get("/expenses", async (c) => {
  const scope = scopeOf(c);
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
  return c.json({ expenses: await loadExpenses(await visibleExpenseIds(scope), limit) });
});

/** One group inside the scope: members, balances, expenses. */
guestRoutes.get("/groups/:id", async (c) => {
  const scope = scopeOf(c);
  const groupId = c.req.param("id");
  if (!isUlid(groupId)) return c.json({ error: "Invalid group id" }, 400);
  if (!scope.groupIds.includes(groupId)) return c.json({ error: "Not found" }, 404);

  const group = await db
    .selectFrom("groups")
    .select(["id", "name", "group_type", "default_currency", "simplify_by_default"])
    .where("id", "=", groupId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  if (!group) return c.json({ error: "Not found" }, 404);

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

  const allVisible = await visibleExpenseIds(scope);
  const inThisGroup = await db
    .selectFrom("expenses")
    .select("id")
    .where("id", "in", allVisible.length ? allVisible : [""])
    .where("group_id", "=", groupId)
    .execute();

  return c.json({
    group,
    members,
    balances: await getGroupBalances(db, groupId),
    expenses: await loadExpenses(inThisGroup.map((e) => e.id), 200),
  });
});

/**
 * The friend-link home: what stands between the guest and the owner.
 *
 * Only reachable on a `friend` link, because only that link has a counterpart.
 */
guestRoutes.get("/friend", async (c) => {
  const scope = scopeOf(c);
  if (!scope.counterpartId) return c.json({ error: "Not found" }, 404);

  const counterpart = await db
    .selectFrom("users")
    .select(["id", "first_name", "last_name"])
    .where("id", "=", scope.counterpartId)
    .executeTakeFirstOrThrow();

  const visible = await visibleExpenseIds(scope);

  return c.json({
    counterpart: {
      id: counterpart.id,
      first_name: counterpart.first_name,
      last_name: counterpart.last_name,
    },
    balances: await getBalanceBetween(db, scope.actingAs, scope.counterpartId),
    expenses: await loadExpenses(visible, 200),
  });
});

guestRoutes.get("/expenses/:id", async (c) => {
  const scope = scopeOf(c);
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  if (!(await inScope(scope, expenseId))) return c.json({ error: "Not found" }, 404);

  const expense = await db
    .selectFrom("expenses")
    .leftJoin("categories", "categories.id", "expenses.category_id")
    .leftJoin("groups", "groups.id", "expenses.group_id")
    .select([
      "expenses.id", "expenses.description", "expenses.details", "expenses.cost_minor",
      "expenses.currency_code", "expenses.date", "expenses.is_payment",
      "expenses.split_type", "expenses.split_meta", "expenses.category_id",
      "expenses.group_id", "categories.name as category_name", "groups.name as group_name",
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

/**
 * The single visibility question, asked the same way everywhere.
 *
 * Reads the participants and hands them to `expenseInScope`, so the "a group
 * link never sees a 1:1 expense" rule lives in exactly one function rather than
 * being re-derived per route.
 */
async function inScope(scope: GuestScope, expenseId: string): Promise<boolean> {
  const expense = await db
    .selectFrom("expenses")
    .select(["id", "group_id"])
    .where("id", "=", expenseId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  if (!expense) return false;

  const participants = await db
    .selectFrom("expense_users")
    .select("user_id")
    .where("expense_id", "=", expenseId)
    .execute();

  return expenseInScope(scope, {
    groupId: expense.group_id,
    participantIds: participants.map((p) => p.user_id),
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * The guest must be ON any expense they write, and everyone on it must be
 * someone this link may name.
 *
 * The first rule stops a guest creating a balance between two other people
 * (which they could then not see and neither could the owner's UI); the second
 * stops a group link reaching outside its group.
 */
async function checkWrite(
  scope: GuestScope,
  groupId: string | null,
  participantIds: string[],
): Promise<string | null> {
  if (!participantIds.includes(scope.actingAs)) {
    return "You have to be one of the people on this expense.";
  }

  const allowed = await writablePeople(db, scope, groupId);
  if (!allowed.ok) return allowed.error;

  const strangers = participantIds.filter((id) => !allowed.allowed.has(id));
  if (strangers.length > 0) {
    return "This link cannot put those people on an expense.";
  }

  return null;
}

guestRoutes.post("/expenses", zValidator("json", genericExpenseBodySchema), async (c) => {
  const scope = scopeOf(c);
  const { groupId = null, ...input } = c.req.valid("json");

  const problem = await checkWrite(scope, groupId, input.participants.map((p) => p.userId));
  if (problem) return c.json({ error: problem }, 403);

  try {
    const id = await createExpense({
      ...input,
      groupId,
      details: input.details ?? null,
      categoryId: input.categoryId ?? null,
      createdBy: scope.actingAs,
    });
    return c.json({ id }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not create expense" }, 400);
  }
});

guestRoutes.patch("/expenses/:id", zValidator("json", genericExpenseBodySchema), async (c) => {
  const scope = scopeOf(c);
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  // Checked against the expense AS IT IS, before the edit is considered: you
  // may only edit something you can already see.
  if (!(await inScope(scope, expenseId))) return c.json({ error: "Not found" }, 404);

  const { groupId = null, ...input } = c.req.valid("json");

  // ...and against the expense AS IT WOULD BE, so an edit cannot move an
  // expense out of the scope that authorised the edit.
  const problem = await checkWrite(scope, groupId, input.participants.map((p) => p.userId));
  if (problem) return c.json({ error: problem }, 403);

  try {
    await updateExpense(expenseId, {
      ...input,
      groupId,
      details: input.details ?? null,
      categoryId: input.categoryId ?? null,
      updatedBy: scope.actingAs,
    });
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Could not update expense" }, 400);
  }
});

guestRoutes.delete("/expenses/:id", async (c) => {
  const scope = scopeOf(c);
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  if (!(await inScope(scope, expenseId))) return c.json({ error: "Not found" }, 404);

  await deleteExpense(expenseId, scope.actingAs);
  return c.json({ ok: true });
});

guestRoutes.post(
  "/payments",
  zValidator(
    "json",
    z.object({
      groupId: ulidSchema.nullable().optional(),
      fromUserId: ulidSchema,
      toUserId: ulidSchema,
      amountMinor: z.number().int().positive(),
      currencyCode: z.string().length(3).toUpperCase(),
      date: z.string().optional(),
    }),
  ),
  async (c) => {
    const scope = scopeOf(c);
    const input = c.req.valid("json");
    const groupId = input.groupId ?? null;

    const problem = await checkWrite(scope, groupId, [input.fromUserId, input.toUserId]);
    if (problem) return c.json({ error: problem }, 403);

    try {
      const id = await createPayment({
        fromUserId: input.fromUserId,
        toUserId: input.toUserId,
        amountMinor: input.amountMinor,
        currencyCode: input.currencyCode,
        groupId,
        date: input.date,
        createdBy: scope.actingAs,
      });
      return c.json({ id }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Could not record payment" }, 400);
    }
  },
);

/** Suggested transfers for a group in scope. Presentational, like the app's. */
guestRoutes.get("/groups/:id/settle", async (c) => {
  const scope = scopeOf(c);
  const groupId = c.req.param("id");
  if (!isUlid(groupId)) return c.json({ error: "Invalid group id" }, 400);
  if (!scope.groupIds.includes(groupId)) return c.json({ error: "Not found" }, 404);

  const balances = await getGroupBalances(db, groupId);
  const byCurrency = new Map<string, Array<{ userId: string; amountMinor: number }>>();

  for (const member of balances) {
    for (const b of member.balances) {
      const list = byCurrency.get(b.currencyCode) ?? [];
      list.push({ userId: member.userId, amountMinor: b.amountMinor });
      byCurrency.set(b.currencyCode, list);
    }
  }

  return c.json({
    suggestions: [...byCurrency.entries()].map(([currencyCode, entries]) => ({
      currencyCode,
      transfers: simplifyDebts(entries),
    })),
  });
});
