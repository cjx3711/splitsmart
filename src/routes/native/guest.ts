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
import { personCamel, personSnake } from "../../domain/person.ts";
import { parseAvatarPattern } from "../../domain/avatar-pattern.ts";
import {
  getGroupBalances,
  getGroupRawEdges,
  getBalanceBetween,
  settleSuggestions,
} from "../../domain/balances.ts";
import {
  createExpense,
  updateExpense,
  deleteExpense,
  createPayment,
} from "../../domain/expenses.ts";
import {
  commentCountSql,
  createComment,
  deleteComment,
  listComments,
} from "../../domain/comments.ts";
import { buildExpenseCsv } from "../../domain/expense-csv.ts";
import { genericExpenseBodySchema, ulidSchema } from "./expense-schema.ts";
import { commentBodySchema, commentErrorResponse, serializeComment } from "./comments.ts";
import {
  expenseFilterWhere,
  hasFilters,
  parseExpenseFilters,
  type ExpenseFilters,
} from "./expense-filters.ts";
import { csvResponse } from "./export.ts";
import { isUlid } from "../../domain/ulid.ts";
import { repeatPausedOf } from "../../domain/metadata.ts";

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

async function loadExpenses(ids: string[], limit: number, filters: ExpenseFilters = {}) {
  if (ids.length === 0) return [];

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
    .where("expenses.id", "in", ids)
    .where("expenses.deleted_at", "is", null)
    .orderBy("expenses.date", "desc")
    .orderBy("expenses.id", "desc")
    .limit(limit);

  // Filters narrow what the scope already allowed. `ids` is the scope and is
  // always applied, so no filter can reach outside the link.
  if (hasFilters(filters)) query = query.where(expenseFilterWhere(filters));

  const expenses = await query.execute();

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
    .select(["id", "name", "nickname", "icon_letters", "icon_emoji", "icon_hue", "icon_pattern", "is_ghost"])
    .where("id", "in", [...ids])
    .execute();

  return rows.map((r) => ({
    ...r,
    icon_pattern: parseAvatarPattern(r.icon_pattern),
  }));
}

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

export const guestRoutes = new Hono<GuestEnv>()
  .use("*", guestAuth)
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
  .get("/session", async (c) => {
  const link = c.get("link");
  const scope = c.get("scope");

  const actable = await listActablePeople(db, link);

  const me = scope
    ? await db
        .selectFrom("users")
        .select(["id", "name", "nickname", "icon_letters", "icon_emoji", "icon_hue", "icon_pattern", "default_currency"])
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
        .select(["id", "name", "nickname", "icon_letters", "icon_emoji", "icon_hue", "icon_pattern"])
        .where("id", "=", scope.counterpartId)
        .executeTakeFirst()
    : null;

  // Who minted this link. For a friend link that's the same person as
  // `counterpart`, but a group link has no counterpart at all, so this is the
  // only way the guest shell can say whose link they are holding.
  const issuedBy = await db
    .selectFrom("users")
    .select(["id", "name", "nickname", "icon_letters", "icon_emoji", "icon_hue", "icon_pattern"])
    .where("id", "=", link.createdBy)
    .executeTakeFirst();

  const groups = scope && scope.groupIds.length
    ? await db
        .selectFrom("groups")
        .select(["id", "name", "group_type", "default_currency"])
        .where("id", "in", scope.groupIds)
        .where("deleted_at", "is", null)
        .orderBy("name")
        .orderBy("id")
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
          ...personCamel(me),
          defaultCurrency: me.default_currency,
        }
      : null,
    group,
    groups,
    counterpart: counterpart
      ? { id: counterpart.id, ...personCamel(counterpart) }
      : null,
    issuedBy: issuedBy ? { id: issuedBy.id, ...personCamel(issuedBy) } : null,
  });
})
/**
 * The currencies table. Same payload as the logged-in `/categories/currencies`.
 *
 * The guest shell has no Dexie mirror, so without this it would call `/api/v1`
 * (which 401s a link token) and every amount would render as a dash. Does not
 * need a picked name: the picker page is already inside CurrencyProvider.
 */
  .get("/currencies", async (c) => {
  const currencies = await db
    .selectFrom("currencies")
    .select(["code", "decimal_places", "symbol", "name"])
    .orderBy("code")
    .execute();
  return c.json({ currencies });
})
  .get("/people", async (c) => {
  return c.json({ people: await visiblePeople(scopeOf(c)) });
})
  .get("/expenses", async (c) => {
  const scope = scopeOf(c);
  const limit = Math.min(Number(c.req.query("limit") ?? 100) || 100, 500);
  const filters = parseExpenseFilters(c.req.query());
  return c.json({
    expenses: await loadExpenses(await visibleExpenseIds(scope), limit, filters),
  });
})
/**
 * The same download the logged-in app offers, over the same builder, with the
 * link's scope as the row set. A guest gets their own history, not the owner's.
 */
  .get("/expenses.csv", async (c) => {
  const scope = scopeOf(c);
  const filters = parseExpenseFilters(c.req.query());

  const visible = await visibleExpenseIds(scope);
  const rows = await loadExpenses(visible, 20_000, filters);
  const csv = await buildExpenseCsv(db, rows.map((e) => e.id));

  return csvResponse(c, csv, "splitsmart-expenses.csv");
})
/** One group inside the scope: members, balances, expenses. */
  .get("/groups/:id", async (c) => {
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
      "users.id",
      "users.name",
      "users.nickname",
      "users.icon_letters",
      "users.icon_emoji",
      "users.icon_hue",
      "users.icon_pattern",
      "users.is_ghost",
      "group_members.role",
      "group_members.joined_via",
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
    members: members.map((m) => ({
      ...m,
      icon_pattern: parseAvatarPattern(m.icon_pattern),
    })),
    balances: await getGroupBalances(db, groupId),
    expenses: await loadExpenses(inThisGroup.map((e) => e.id), 200),
  });
})
/**
 * The friend-link home: what stands between the guest and the owner.
 *
 * Only reachable on a `friend` link, because only that link has a counterpart.
 */
  .get("/friend", async (c) => {
  const scope = scopeOf(c);
  if (!scope.counterpartId) return c.json({ error: "Not found" }, 404);

  const counterpart = await db
    .selectFrom("users")
    .select(["id", "name", "nickname", "icon_letters", "icon_emoji", "icon_hue", "icon_pattern"])
    .where("id", "=", scope.counterpartId)
    .executeTakeFirstOrThrow();

  const visible = await visibleExpenseIds(scope);

  return c.json({
    counterpart: {
      id: counterpart.id,
      ...personSnake(counterpart),
    },
    balances: await getBalanceBetween(db, scope.actingAs, scope.counterpartId),
    expenses: await loadExpenses(visible, 200),
  });
})
  .get("/expenses/:id", async (c) => {
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
      "expenses.group_id", "expenses.repeat_interval", "expenses.next_repeat",
      "expenses.repeat_of", "expenses.metadata",
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

  const { metadata, ...publicExpense } = expense;

  return c.json({
    expense: {
      ...publicExpense,
      shares,
      repeat_paused: repeatPausedOf(metadata),
    },
  });
})
  .post("/expenses", zValidator("json", genericExpenseBodySchema), async (c) => {
  const scope = scopeOf(c);
  // `repeatInterval` is dropped rather than rejected. A guest can add and edit
  // bills, but starting a recurring series is a server job the owner cannot see
  // or stop from their side, so v1 keeps templates logged-in only
  // (docs/PARITY.md slice 2). Occurrences are ordinary expenses and stay visible.
  const { groupId = null, repeatInterval: _ignored, ...input } = c.req.valid("json");

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
})
  .patch("/expenses/:id", zValidator("json", genericExpenseBodySchema), async (c) => {
  const scope = scopeOf(c);
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  // Checked against the expense AS IT IS, before the edit is considered: you
  // may only edit something you can already see.
  if (!(await inScope(scope, expenseId))) return c.json({ error: "Not found" }, 404);

  // Same reasoning as the create above, and here dropping it is what LEAVES an
  // existing series alone: `updateExpense` treats absent as "do not touch the
  // schedule", so a guest fixing a typo cannot end the owner's rent series.
  const { groupId = null, repeatInterval: _ignored, ...input } = c.req.valid("json");

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
})
  .delete("/expenses/:id", async (c) => {
  const scope = scopeOf(c);
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  if (!(await inScope(scope, expenseId))) return c.json({ error: "Not found" }, 404);

  await deleteExpense(expenseId, scope.actingAs);
  return c.json({ ok: true });
})
  .post(
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
      description: z.string().min(1).max(500).optional(),
      details: z.string().max(5000).optional(),
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
        description: input.description,
        details: input.details,
        createdBy: scope.actingAs,
      });
      return c.json({ id }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "Could not record payment" }, 400);
    }
  },
)
// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------
//
// A guest who can see a bill can talk about it. The scope question is the same
// one every read here asks (`inScope`), so a group link still cannot reach a 1:1
// expense, and the person speaking is always the name the link acts as.
//
// What a guest cannot do: write a system comment (there is no `kind` on the
// wire anywhere), or delete somebody else's note. Both are enforced in
// src/domain/comments.ts rather than here, so the two shells cannot disagree.
  .get("/expenses/:id/comments", async (c) => {
  const scope = scopeOf(c);
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  if (!(await inScope(scope, expenseId))) return c.json({ error: "Not found" }, 404);

  const comments = await listComments(db, expenseId);
  return c.json({ comments: comments.map(serializeComment) });
})
  .post("/expenses/:id/comments", zValidator("json", commentBodySchema), async (c) => {
  const scope = scopeOf(c);
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  if (!(await inScope(scope, expenseId))) return c.json({ error: "Not found" }, 404);

  const input = c.req.valid("json");

  try {
    const id = await createComment({
      id: input.id,
      expenseId,
      userId: scope.actingAs,
      content: input.content,
      kind: "user",
    });
    const comments = await listComments(db, expenseId);
    const created = comments.find((comment) => comment.id === id);
    return c.json({ comment: created ? serializeComment(created) : null }, 201);
  } catch (err) {
    const mapped = commentErrorResponse(err);
    return c.json({ error: mapped.error }, mapped.status);
  }
})
  .delete("/comments/:id", async (c) => {
  const scope = scopeOf(c);
  const commentId = c.req.param("id");
  if (!isUlid(commentId)) return c.json({ error: "Invalid comment id" }, 400);

  // The link's scope is checked as well as authorship: `deleteComment` asks
  // whether the person may see the expense, which for a ghost is true in any
  // group they belong to, not only the one this link covers.
  const comment = await db
    .selectFrom("comments")
    .select(["id", "expense_id"])
    .where("id", "=", commentId)
    .executeTakeFirst();

  if (!comment || !(await inScope(scope, comment.expense_id))) {
    return c.json({ error: "Not found" }, 404);
  }

  try {
    await deleteComment(commentId, scope.actingAs);
    return c.json({ ok: true });
  } catch (err) {
    const mapped = commentErrorResponse(err);
    return c.json({ error: mapped.error }, mapped.status);
  }
})
/** Suggested transfers for a group in scope. Simplified or raw, like the app's. */
  .get("/groups/:id/settle", async (c) => {
  const scope = scopeOf(c);
  const groupId = c.req.param("id");
  if (!isUlid(groupId)) return c.json({ error: "Invalid group id" }, 400);
  if (!scope.groupIds.includes(groupId)) return c.json({ error: "Not found" }, 404);

  const group = await db
    .selectFrom("groups")
    .select("simplify_by_default")
    .where("id", "=", groupId)
    .executeTakeFirst();

  const [members, edges] = await Promise.all([
    getGroupBalances(db, groupId),
    getGroupRawEdges(db, groupId),
  ]);

  return c.json({
    suggestions: settleSuggestions({
      simplify: group?.simplify_by_default === 1,
      members,
      edges,
    }),
  });
});
