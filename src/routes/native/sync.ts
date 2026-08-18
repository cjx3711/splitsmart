/**
 * `/api/v1/sync/*` - the endpoints an offline-capable client replicates through.
 *
 * Three reads and one write, all for a LOGGED-IN account: a cookie session or a
 * bearer API token. `requireAuth` rejects a `link_` guest secret outright, which
 * is the whole reason this can be a plain native router - a guest link is a
 * capability its owner can expire at any moment, and offline-first means keeping a
 * copy the owner cannot revoke. Those two disagree, so link visitors stay
 * live-only. See docs/GUEST.md and docs/OFFLINE.md.
 *
 *   GET  /bootstrap   everything you can see, plus the seq to start from
 *   GET  /snapshot    catch up on one group, or one expense's thread
 *   GET  /pull        what changed since a seq
 *   POST /push        queued writes, routed to the existing domain writers
 *
 * `/push` ADDS NO SQL against `expenses`, `expense_users` or
 * `expense_repayments`. It is a batching wrapper over `createExpense`,
 * `updateExpense`, `deleteExpense`, `restoreExpense`, `createComment` and
 * `deleteComment` - rule 3 has no exceptions, and it is the only thing enforcing
 * the expense invariant, so offline writes give `yarn db:check` no new audit
 * surface.
 *
 * Nothing here computes a balance. Balances are derived on the client from
 * `expense_users` via the same pure `deriveRepayments` the server uses, because a
 * pairwise net taken from two people's shares on a three-way bill is wrong
 * (docs/OFFLINE.md, decision 3).
 */
import { Hono } from "hono";
import { compress } from "hono/compress";
import { gunzipSync } from "node:zlib";
import { sql } from "kysely";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import {
  createExpense,
  deleteExpense,
  restoreExpense,
  updateExpense,
  ExpenseConflictError,
} from "../../domain/expenses.ts";
import { createComment, deleteComment, CommentError } from "../../domain/comments.ts";
import { listRelatedUserIds } from "../../domain/friends.ts";
import { currentSeq } from "../../domain/sync-log.ts";
import { isUlid } from "../../domain/ulid.ts";
import { expenseBodyFields, ulidSchema } from "./expense-schema.ts";
import {
  loadCategories,
  loadComments,
  loadCommentsForExpenses,
  loadCurrencies,
  loadExpenses,
  loadFriendships,
  loadGroupMember,
  loadGroupMembers,
  loadGroups,
  loadUsers,
  serialiseFriendships,
} from "./sync-serializers.ts";

export const syncRoutes = new Hono<AppEnv>();
syncRoutes.use("*", requireAuth);
// Pull / bootstrap / snapshot can be large. The browser decompresses gzip
// automatically; we do not gzip them in the client. Push bodies are gzipped
// the other way - see readPushBody.
syncRoutes.use("*", compress());

/**
 * Expenses per bootstrap page.
 *
 * Bounded because a long-standing account's whole history is not a single
 * response, and generous because the round trip costs more than the rows do.
 */
const BOOTSTRAP_PAGE = 400;

// ---------------------------------------------------------------------------
// Visibility
// ---------------------------------------------------------------------------

/**
 * Groups the caller has a membership row for, LEFT ONES INCLUDED.
 *
 * Deliberately not filtered on `left_at`. Leaving a group does not hide the
 * expenses in it that you are a participant of - that is the rule the All
 * Expenses screen has always used - so the client still needs the group's name
 * to render them. A group row is a name and a default currency; it is not access.
 */
async function visibleGroupIds(userId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("group_members")
    .select("group_id")
    .where("user_id", "=", userId)
    .execute();
  return [...new Set(rows.map((r) => r.group_id))];
}

/**
 * One page of expense ids the caller may see, in id order.
 *
 * The same rule as `canSeeExpense`: you are on the bill, or you are currently in
 * its group. A UNION of two indexed scans rather than an OR, so each half uses
 * its own index (`idx_expense_users_user_id`, `idx_expenses_group_id`) instead of
 * degrading into a table scan.
 *
 * ULIDs sort lexicographically by creation time, so `id > cursor` is a stable
 * keyset cursor: no OFFSET, and a row inserted mid-pagination cannot shift a
 * later page onto rows the client has already had.
 */
async function visibleExpenseIdPage(
  userId: string,
  cursor: string | null,
  limit: number,
): Promise<string[]> {
  const rows = await sql<{ id: string }>`
    SELECT id FROM (
      SELECT eu.expense_id AS id
      FROM expense_users eu
      WHERE eu.user_id = ${userId}

      UNION

      SELECT e.id AS id
      FROM expenses e
      WHERE e.group_id IN (
        SELECT group_id FROM group_members
        WHERE user_id = ${userId} AND left_at IS NULL
      )
    )
    WHERE id > ${cursor ?? ""}
    ORDER BY id
    LIMIT ${limit}
  `.execute(db);

  return rows.rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// GET /bootstrap
// ---------------------------------------------------------------------------

/**
 * Everything the caller can see, for a fresh install or a local database reset.
 *
 * `seq` IS CAPTURED BEFORE ANYTHING IS READ, and the client keeps the value from
 * the FIRST page for the whole run. Snapshotting it at the end instead would
 * drop every write that landed after its page had already been scanned - those
 * changes are below the cursor, so no later pull would ever deliver them. Taking
 * it first means the opposite error, a change delivered twice, and applying a
 * whole-entity upsert twice is a no-op.
 *
 * Reference data (currencies, categories) rides along on the first page only.
 * That is not an optimisation: `web/src/money.tsx` will not render an amount
 * without its currency's decimal places, so a client that has expenses and no
 * currencies table shows a screen of dashes.
 */
syncRoutes.get("/bootstrap", async (c) => {
  const auth = c.get("user");

  const seq = await currentSeq(db);

  const rawCursor = c.req.query("cursor") ?? null;
  if (rawCursor !== null && !isUlid(rawCursor)) {
    return c.json({ error: "Invalid cursor" }, 400);
  }
  const cursor = rawCursor;
  const first = cursor === null;

  const expenseIds = await visibleExpenseIdPage(auth.id, cursor, BOOTSTRAP_PAGE);
  const [expenses, comments] = await Promise.all([
    loadExpenses(db, expenseIds),
    loadCommentsForExpenses(db, expenseIds),
  ]);

  // A short page means the end. Equal to the limit is ambiguous - the next page
  // may be empty - and one wasted round trip beats a truncated ledger.
  const nextCursor = expenseIds.length === BOOTSTRAP_PAGE ? expenseIds.at(-1)! : null;

  if (!first) {
    return c.json({ seq, expenses, comments, nextCursor });
  }

  const groupIds = await visibleGroupIds(auth.id);
  const [self, groups, members, friendships, currencies, categories] = await Promise.all([
    loadUsers(db, [auth.id]),
    loadGroups(db, groupIds),
    loadGroupMembers(db, groupIds),
    loadFriendships(db, auth.id),
    loadCurrencies(db),
    loadCategories(db),
  ]);

  return c.json({
    seq,
    self: self.get(auth.id) ?? null,
    groups,
    members,
    friendships,
    expenses,
    comments,
    currencies,
    categories,
    nextCursor,
  });
});

// ---------------------------------------------------------------------------
// GET /snapshot
// ---------------------------------------------------------------------------

/**
 * Catch-up for access the caller has just been granted.
 *
 * Incremental pull is `seq > :since` and does not backfill: the log rows for a
 * group's ten-year history are all below the cursor of a client that has been
 * syncing for months, so joining that group would deliver the membership row and
 * nothing else. This is the endpoint that fills the gap, and `/pull` names it
 * explicitly in `catchUp` rather than making the client guess.
 *
 * Two shapes, because there are two ways to gain access:
 *
 *   ?group_id=  a group you are now in: the group, its members, its expenses and
 *               their threads.
 *   ?expense_id= one non-group bill you have just been added to. THE THREAD
 *               ONLY - the expense itself arrives as an ordinary upsert in the
 *               same pull page. Its comments are a separate entity whose seqs are
 *               all below the cursor, which is the entire gap being closed here.
 *
 * Does NOT rewind the cursor. The client applies what it gets and leaves `since`
 * where the pull page put it.
 */
syncRoutes.get("/snapshot", async (c) => {
  const auth = c.get("user");
  const groupId = c.req.query("group_id");
  const expenseId = c.req.query("expense_id");

  if ((groupId === undefined) === (expenseId === undefined)) {
    return c.json({ error: "Pass exactly one of group_id or expense_id" }, 400);
  }

  if (expenseId !== undefined) {
    if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

    // Participant-only, and 404 rather than 403 for a stranger: a 403 would
    // confirm the expense exists. Same rule as GET /expenses/:id.
    const participant = await db
      .selectFrom("expense_users")
      .select("user_id")
      .where("expense_id", "=", expenseId)
      .where("user_id", "=", auth.id)
      .executeTakeFirst();

    if (!participant) return c.json({ error: "Not found" }, 404);

    return c.json({
      expenses: await loadExpenses(db, [expenseId]),
      comments: await loadCommentsForExpenses(db, [expenseId]),
    });
  }

  if (!isUlid(groupId!)) return c.json({ error: "Invalid group id" }, 400);

  const membership = await db
    .selectFrom("group_members")
    .select("user_id")
    .where("group_id", "=", groupId!)
    .where("user_id", "=", auth.id)
    .where("left_at", "is", null)
    .executeTakeFirst();

  if (!membership) return c.json({ error: "Not found" }, 404);

  const expenseIds = (
    await db
      .selectFrom("expenses")
      .select("id")
      .where("group_id", "=", groupId!)
      .orderBy("id")
      .execute()
  ).map((r) => r.id);

  const [groups, members, expenses, comments] = await Promise.all([
    loadGroups(db, [groupId!]),
    loadGroupMembers(db, [groupId!]),
    loadExpenses(db, expenseIds),
    loadCommentsForExpenses(db, expenseIds),
  ]);

  return c.json({ groups, members, expenses, comments });
});

// ---------------------------------------------------------------------------
// GET /pull
// ---------------------------------------------------------------------------

/** Log rows per pull page. Drained in one sync cycle, not one page per tick. */
const PULL_PAGE = 1000;

/** A log row, as the audience query returns it. */
interface LogRow {
  seq: number;
  entity: string;
  entity_id: string;
  other_user_id: string | null;
  op: string;
  group_id: string | null;
  audience_user_id: string | null;
}

/**
 * Every log row after `since` that this caller is entitled to.
 *
 * A UNION of index-friendly branches rather than one WHERE with a pile of ORs.
 * SQLite will use at most one index per table reference, so the OR form degrades
 * into a scan of the whole log on every sync; each branch here can use its own
 * (`idx_sync_log_group`, `idx_sync_log_entity`, `idx_sync_log_audience`).
 *
 * The branches, and why each exists:
 *
 *   1. Anything in a group you are CURRENTLY in - expenses, comments, the group
 *      itself, other people's memberships.
 *   2. Expenses you are a participant of, wherever they live. Leaving a group does
 *      not hide the bills you are personally on.
 *   3. Comments on those expenses. A separate branch because a comment's own
 *      `entity_id` is the comment, not the bill.
 *   4. YOUR OWN membership rows. Load-bearing: once `left_at` is set you stop
 *      matching branch 1, so without this you would never receive the row that
 *      tells you you left.
 *   5. Friendships naming you on either side.
 *   6. A merge whose survivor is you.
 *   7. Your own profile.
 *   8. Anything addressed to you specifically: a `forget`, or the fan-out of a
 *      merge. By the time others pull, the ghost is already gone from
 *      `expense_users`, so "who knew this person" cannot be answered at read time
 *      and the writer had to name them.
 */
async function pullPage(userId: string, since: number, limit: number): Promise<LogRow[]> {
  const rows = await sql<LogRow>`
    SELECT seq, entity, entity_id, other_user_id, op, group_id, audience_user_id
    FROM (
      SELECT * FROM sync_log
      WHERE seq > ${since}
        AND group_id IN (
          SELECT group_id FROM group_members WHERE user_id = ${userId} AND left_at IS NULL
        )

      UNION

      SELECT * FROM sync_log
      WHERE seq > ${since}
        AND entity = 'expense'
        AND entity_id IN (SELECT expense_id FROM expense_users WHERE user_id = ${userId})

      UNION

      SELECT * FROM sync_log
      WHERE seq > ${since}
        AND entity = 'comment'
        AND entity_id IN (
          SELECT c.id FROM comments c
          JOIN expense_users eu ON eu.expense_id = c.expense_id
          WHERE eu.user_id = ${userId}
        )

      UNION

      SELECT * FROM sync_log
      WHERE seq > ${since} AND entity = 'group_member' AND entity_id = ${userId}

      UNION

      SELECT * FROM sync_log
      WHERE seq > ${since}
        AND entity = 'friendship'
        AND (entity_id = ${userId} OR other_user_id = ${userId})

      UNION

      SELECT * FROM sync_log
      WHERE seq > ${since} AND entity = 'user_merge' AND other_user_id = ${userId}

      UNION

      SELECT * FROM sync_log
      WHERE seq > ${since} AND entity = 'user' AND entity_id = ${userId}

      UNION

      SELECT * FROM sync_log
      WHERE seq > ${since} AND audience_user_id = ${userId}
    )
    ORDER BY seq
    LIMIT ${limit}
  `.execute(db);

  return rows.rows;
}

/**
 * How many rows are still waiting past this page.
 *
 * Only ever called when the page came back full, because it re-runs the whole
 * audience union to count and there is no point paying for that to learn "none".
 */
async function pullRemaining(userId: string, since: number): Promise<number> {
  const page = await pullPage(userId, since, PULL_PAGE * 100);
  return page.length;
}

/**
 * The key a row upserts under.
 *
 * Junction tables have no surrogate id, so two log rows describing the same
 * membership must collapse to one change. See the encoding table in
 * migrations/001_initial_schema.sql.
 */
function changeKey(row: LogRow): string {
  if (row.entity === "group_member") return `group_member:${row.group_id}:${row.entity_id}`;
  if (row.entity === "friendship") return `friendship:${row.entity_id}:${row.other_user_id}`;
  if (row.entity === "user_merge") return `user_merge:${row.entity_id}:${row.other_user_id}`;
  return `${row.entity}:${row.entity_id}`;
}

/**
 * What changed since `since`.
 *
 * Entities are returned WHOLE, and the page is collapsed so each entity appears
 * once, carrying its final state and the seq of the last row that touched it.
 * Three edits to one bill in one page are one upsert of the current row - the
 * client is replacing a document either way, and replaying the intermediate
 * states would only widen the window in which its screens show a number that was
 * never final.
 *
 * `catchUp` is collected from the RAW rows, before that collapse: the marker for
 * "you have just been added to this bill" is a second expense upsert addressed to
 * the caller, and it is the same (entity, id) as the ordinary one it accompanies.
 *
 * Drain `more` within one sync cycle rather than one page per tick. A client that
 * takes a page every five minutes is not syncing, it is trickling.
 */
syncRoutes.get("/pull", async (c) => {
  const auth = c.get("user");

  const since = Number(c.req.query("since") ?? 0);
  if (!Number.isInteger(since) || since < 0) {
    return c.json({ error: "since must be a non-negative integer" }, 400);
  }

  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? PULL_PAGE) || PULL_PAGE, 1), PULL_PAGE);

  const rows = await pullPage(auth.id, since, limit + 1);
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;

  if (page.length === 0) {
    return c.json({ changes: [], seq: since, more: false, remaining: 0, catchUp: [] });
  }

  // Last row per entity wins. Insertion order in a Map is preserved, and the
  // rows arrive in seq order, so re-setting a key keeps its original position -
  // which is what makes a `user_merge` stay ahead of the expense upserts it has
  // to be applied before.
  const collapsed = new Map<string, LogRow>();
  for (const row of page) collapsed.set(changeKey(row), row);

  const latest = [...collapsed.values()];

  // Batch the payload loads: one query per entity kind, not one per change.
  const expenseIds = latest
    .filter((r) => r.entity === "expense" && r.op !== "forget")
    .map((r) => r.entity_id);
  const commentIds = latest.filter((r) => r.entity === "comment").map((r) => r.entity_id);
  const groupIds = latest.filter((r) => r.entity === "group").map((r) => r.entity_id);
  const userIds = latest.filter((r) => r.entity === "user").map((r) => r.entity_id);

  const [expenses, comments, groups, users] = await Promise.all([
    loadExpenses(db, expenseIds),
    loadComments(db, commentIds),
    loadGroups(db, groupIds),
    loadUsers(db, userIds),
  ]);

  const expenseById = new Map(expenses.map((e) => [e.id, e]));
  const commentById = new Map(comments.map((cm) => [cm.id, cm]));
  const groupById = new Map(groups.map((g) => [g.id, g]));

  const changes: Array<{ seq: number; entity: string; op: string; data: unknown }> = [];

  for (const row of latest) {
    const data = await payloadFor(row, auth.id, {
      expenseById,
      commentById,
      groupById,
      users,
    });
    // A row whose entity has vanished from under it. Skipping is right: there is
    // nothing to deliver, and the cursor still advances past it so the client does
    // not ask again forever.
    if (data === null) continue;
    changes.push({ seq: row.seq, entity: row.entity, op: row.op, data });
  }

  const catchUp = await collectCatchUp(page, auth.id);
  const head = page.at(-1)!.seq;

  return c.json({
    changes,
    seq: head,
    more,
    remaining: more ? await pullRemaining(auth.id, head) : 0,
    catchUp,
  });
});

/** Builds one change's `data`, from the batches loaded above. */
async function payloadFor(
  row: LogRow,
  viewerId: string,
  loaded: {
    expenseById: Map<string, Awaited<ReturnType<typeof loadExpenses>>[number]>;
    commentById: Map<string, Awaited<ReturnType<typeof loadComments>>[number]>;
    groupById: Map<string, Awaited<ReturnType<typeof loadGroups>>[number]>;
    users: Map<string, Awaited<ReturnType<typeof loadUsers>> extends Map<string, infer U> ? U : never>;
  },
): Promise<unknown | null> {
  switch (row.entity) {
    case "expense":
      // A forget carries the id and nothing else. The caller may not see this row
      // any more, so sending its contents would be the opposite of the point.
      if (row.op === "forget") return { id: row.entity_id };
      return loaded.expenseById.get(row.entity_id) ?? null;

    case "comment":
      return loaded.commentById.get(row.entity_id) ?? null;

    case "group":
      return loaded.groupById.get(row.entity_id) ?? null;

    case "group_member":
      if (row.group_id === null) return null;
      return loadGroupMember(db, row.group_id, row.entity_id);

    case "friendship": {
      if (row.other_user_id === null) return null;
      if (row.op === "delete") {
        return { userAId: row.entity_id, userBId: row.other_user_id };
      }
      const [friendship] = await serialiseFriendships(
        db,
        await db
          .selectFrom("friendships")
          .select(["user_a_id", "user_b_id", "created_at"])
          .where("user_a_id", "=", row.entity_id)
          .where("user_b_id", "=", row.other_user_id)
          .execute(),
        viewerId,
      );
      return friendship ?? null;
    }

    case "user":
      return loaded.users.get(row.entity_id) ?? null;

    case "user_merge":
      // No entity to load: the ghost is retired and the survivor arrives nested on
      // the expense upserts that follow. The client needs only the two ids.
      return { fromUserId: row.entity_id, toUserId: row.other_user_id };

    default:
      return null;
  }
}

/**
 * The catch-up list for this page.
 *
 * Incremental pull is `seq > :since` and never backfills, so a caller who has
 * just gained access to something gets the row that granted it and none of the
 * history behind it. These two cases are exactly where that gap opens:
 *
 *   - A LIVE `group_member` row naming the caller. They are in a group whose
 *     expenses and threads are all below their cursor. A `left_at` row is not a
 *     grant and gets nothing.
 *   - An expense upsert ADDRESSED to the caller. That marker is only written for a
 *     non-group bill they have just been added to (src/domain/sync-log.ts): the
 *     expense arrives as the ordinary upsert, but its comments are a separate
 *     entity with old seqs, so without this the bill lands with an empty thread.
 *
 * Built from the raw page rather than the collapsed one, because the marker shares
 * its (entity, id) with the ordinary upsert next to it.
 */
async function collectCatchUp(
  rows: LogRow[],
  viewerId: string,
): Promise<Array<{ entity: "group" | "expense"; id: string }>> {
  const groups = new Set<string>();
  const expenses = new Set<string>();

  for (const row of rows) {
    if (
      row.entity === "group_member" &&
      row.entity_id === viewerId &&
      row.op === "upsert" &&
      row.group_id !== null
    ) {
      groups.add(row.group_id);
    }
    if (
      row.entity === "expense" &&
      row.op === "upsert" &&
      row.audience_user_id === viewerId
    ) {
      expenses.add(row.entity_id);
    }
  }

  const result: Array<{ entity: "group" | "expense"; id: string }> = [];

  for (const groupId of groups) {
    // Only a live membership is a grant. Being removed is the opposite, and
    // snapshotting a group you have just left would hand back everything the
    // `left_at` row is about to make you drop.
    const membership = await db
      .selectFrom("group_members")
      .select("user_id")
      .where("group_id", "=", groupId)
      .where("user_id", "=", viewerId)
      .where("left_at", "is", null)
      .executeTakeFirst();
    if (membership) result.push({ entity: "group", id: groupId });
  }

  for (const expenseId of expenses) result.push({ entity: "expense", id: expenseId });

  return result;
}

// ---------------------------------------------------------------------------
// POST /push
// ---------------------------------------------------------------------------

/**
 * A BATCHING WRAPPER, and nothing more.
 *
 * Every op below is routed to the existing domain writer - `createExpense`,
 * `updateExpense`, `deleteExpense`, `restoreExpense`, `createComment`,
 * `deleteComment` - and this file adds no SQL of its own against `expenses`,
 * `expense_users` or `expense_repayments`. That is rule 3 and it is the only thing
 * enforcing the expense invariant, so `yarn db:check` gains no new audit surface
 * from offline writes: a replayed batch goes through exactly the code path a
 * browser form goes through.
 *
 * An unsynced local expense is therefore a PROVISIONAL RECORD, not ledger truth.
 * The server recomputes the split on replay and stays authoritative; if the two
 * disagree by a cent, the server is right.
 */

const participantSchema = z.object({
  userId: ulidSchema,
  paidMinor: z.number().int().min(0),
  input: z.number().optional(),
});

/**
 * The four outcomes, and the client's obligation for each:
 *
 *   applied    it landed. Carries the new `version`; clear the outbox entry.
 *   duplicate  the id was already there, or a delete/restore of a row already in
 *              that state. NOT an error - it is the lost-response case. Carries
 *              the STORED ROW, because the client's copy may differ from it and
 *              the server's is the one that counts.
 *   conflict   `baseVersion` was stale. Carries the server's current row; the
 *              entry moves to a conflict state, not the bin.
 *   rejected   cannot be applied exactly: unknown currency, a departed member,
 *              shares that do not sum. Carries a reason and writes nothing.
 *
 * REJECTIONS MUST BE VISIBLE, the same discipline as the importer's `skipped[]`.
 * An expense that quietly vanishes between two devices is worse than an error
 * message, so a rejected op goes to a quarantine list the user can see.
 */
type PushStatus = "applied" | "duplicate" | "conflict" | "rejected";

interface PushResult {
  id: string;
  kind: string;
  status: PushStatus;
  version?: number;
  reason?: string;
  /** The stored entity, on `duplicate` and `conflict`. */
  server?: unknown;
}

const pushOpSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("expense.create"),
    id: ulidSchema,
    payload: z.object({ ...expenseBodyFields, groupId: ulidSchema.nullable().optional() }),
  }),
  z.object({
    kind: z.literal("payment.create"),
    id: ulidSchema,
    payload: z.object({ ...expenseBodyFields, groupId: ulidSchema.nullable().optional() }),
  }),
  z.object({
    kind: z.literal("expense.update"),
    id: ulidSchema,
    baseVersion: z.number().int().positive(),
    payload: z.object({ ...expenseBodyFields, groupId: ulidSchema.nullable().optional() }),
  }),
  z.object({
    kind: z.literal("expense.delete"),
    id: ulidSchema,
    baseVersion: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("expense.restore"),
    id: ulidSchema,
    baseVersion: z.number().int().positive(),
    /**
     * Restore-and-replace, folded by the outbox reducer into one op. The wrapper
     * restores and then updates in the same request and returns the FINAL version:
     * the client cannot know the post-restore version in between, so splitting
     * this into two round trips would guarantee a conflict on the second.
     */
    payload: z
      .object({ ...expenseBodyFields, groupId: ulidSchema.nullable().optional() })
      .optional(),
  }),
  z.object({
    kind: z.literal("comment.create"),
    id: ulidSchema,
    payload: z.object({
      expenseId: ulidSchema,
      content: z.string().min(1).max(5000),
    }),
  }),
  z.object({
    kind: z.literal("comment.delete"),
    id: ulidSchema,
  }),
]);

const pushSchema = z.object({
  // Bounded so one client cannot hold a write transaction for a minute. The
  // client drains its queue in batches; a partial batch is fine because every op
  // is independently idempotent.
  ops: z.array(pushOpSchema).min(1).max(200),
});

type PushOp = z.infer<typeof pushOpSchema>;

/**
 * Reads the push body, gunzipping when the client said it did.
 *
 * CompressionStream in the browser, zlib here. A threshold lives on the client;
 * anything that arrives with the header is inflated, small bodies included.
 */
async function readPushBody(c: { req: { header: (name: string) => string | undefined; arrayBuffer: () => Promise<ArrayBuffer>; json: () => Promise<unknown> } }): Promise<unknown> {
  const encoding = (c.req.header("content-encoding") ?? "").toLowerCase();
  if (encoding !== "gzip") return c.req.json();
  const inflated = gunzipSync(Buffer.from(await c.req.arrayBuffer()));
  return JSON.parse(inflated.toString("utf8"));
}

syncRoutes.post("/push", async (c) => {
  let raw: unknown;
  try {
    raw = await readPushBody(c);
  } catch {
    return c.json({ error: "Could not read body" }, 400);
  }
  const parsed = pushSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "Invalid body" }, 400);

  const auth = c.get("user");
  const { ops } = parsed.data;

  const results: PushResult[] = [];

  // Sequential, deliberately. The ops in one batch can depend on each other - a
  // comment on an expense created two entries earlier - and every writer opens
  // its own transaction, so running them concurrently would race a child against
  // its parent for no gain on a single SQLite connection.
  for (const op of ops) {
    results.push(await applyPushOp(auth.id, op));
  }

  return c.json({ results, seq: await currentSeq(db) });
});

/** Runs one op, turning every failure into a status rather than a 500. */
async function applyPushOp(userId: string, op: PushOp): Promise<PushResult> {
  try {
    switch (op.kind) {
      case "expense.create":
      case "payment.create":
        return await pushCreate(userId, op);
      case "expense.update":
        return await pushUpdate(userId, op);
      case "expense.delete":
        return await pushDelete(userId, op);
      case "expense.restore":
        return await pushRestore(userId, op);
      case "comment.create":
        return await pushCommentCreate(userId, op);
      case "comment.delete":
        return await pushCommentDelete(userId, op);
    }
  } catch (err) {
    if (err instanceof ExpenseConflictError) {
      return {
        id: op.id,
        kind: op.kind,
        status: "conflict",
        version: err.currentVersion,
        server: (await loadExpenses(db, [op.id]))[0] ?? null,
      };
    }
    return {
      id: op.id,
      kind: op.kind,
      status: "rejected",
      reason: err instanceof Error ? err.message : "Could not apply this change",
    };
  }
}

/**
 * The same participant rules as `POST /api/v1/expenses`.
 *
 * Not a lighter version of them. Push is a batching wrapper over the same
 * writers, so it has to be a batching wrapper over the same authorisation too -
 * otherwise the queue is a way around a check the online form enforces.
 */
async function assertMayWrite(
  userId: string,
  groupId: string | null,
  participants: Array<{ userId: string }>,
): Promise<void> {
  if (!participants.some((p) => p.userId === userId)) {
    throw new Error("You have to be one of the people on this expense.");
  }

  if (groupId !== null) {
    const membership = await db
      .selectFrom("group_members")
      .select("user_id")
      .where("group_id", "=", groupId)
      .where("user_id", "=", userId)
      .where("left_at", "is", null)
      .executeTakeFirst();
    // The "left the group, then pushed a create you made while still in it" case.
    // Rejected with a reason rather than coerced to a non-group expense: quietly
    // moving somebody's bill out of the group it belonged to is not a fix.
    if (!membership) throw new Error("You are no longer a member of that group.");
    return;
  }

  const allowed = new Set([userId, ...(await listRelatedUserIds(db, userId))]);
  if (participants.some((p) => !allowed.has(p.userId))) {
    throw new Error("A non-group expense can only involve you and people you share history with.");
  }
}

/** Whether the caller is on this bill. Deletes and restores are participant-only. */
async function assertParticipant(userId: string, expenseId: string): Promise<void> {
  const row = await db
    .selectFrom("expense_users")
    .select("user_id")
    .where("expense_id", "=", expenseId)
    .where("user_id", "=", userId)
    .executeTakeFirst();
  if (!row) throw new Error("Not found");
}

async function pushCreate(
  userId: string,
  op: Extract<PushOp, { kind: "expense.create" | "payment.create" }>,
): Promise<PushResult> {
  // Checked BEFORE the writer, because `createExpense` short-circuits a known id
  // without validating anything - which is right for a retry, and would be a hole
  // here if it meant skipping the participant rules on a first write.
  const existing = await db
    .selectFrom("expenses")
    .select("id")
    .where("id", "=", op.id)
    .executeTakeFirst();

  if (existing) {
    // The lost-response case: our write landed, the answer did not. Hand back the
    // STORED row, not just the id - the client's copy may differ and the server's
    // is the one that counts.
    const [server] = await loadExpenses(db, [op.id]);
    return {
      id: op.id,
      kind: op.kind,
      status: "duplicate",
      version: server?.version,
      server: server ?? null,
    };
  }

  const { groupId = null, ...input } = op.payload;
  await assertMayWrite(userId, groupId, input.participants);

  await createExpense({
    ...input,
    id: op.id,
    groupId,
    details: input.details ?? null,
    categoryId: input.categoryId ?? null,
    // The only thing that distinguishes the two create kinds. `is_payment` is not
    // a field on the expense body - the online API decides it by which route was
    // called - so here the op kind is what decides it.
    isPayment: op.kind === "payment.create",
    createdBy: userId,
  });

  return { id: op.id, kind: op.kind, status: "applied", version: 1 };
}

async function pushUpdate(
  userId: string,
  op: Extract<PushOp, { kind: "expense.update" }>,
): Promise<PushResult> {
  await assertParticipant(userId, op.id);

  const { groupId = null, ...input } = op.payload;
  await assertMayWrite(userId, groupId, input.participants);

  const result = await updateExpense(op.id, {
    ...input,
    groupId,
    details: input.details ?? null,
    categoryId: input.categoryId ?? null,
    updatedBy: userId,
    expectedVersion: op.baseVersion,
  });

  return { id: op.id, kind: op.kind, status: "applied", version: result.version };
}

async function pushDelete(
  userId: string,
  op: Extract<PushOp, { kind: "expense.delete" }>,
): Promise<PushResult> {
  await assertParticipant(userId, op.id);

  const result = await deleteExpense(op.id, userId, { expectedVersion: op.baseVersion });
  if (result.noop) {
    const [server] = await loadExpenses(db, [op.id]);
    return {
      id: op.id,
      kind: op.kind,
      status: "duplicate",
      version: result.version,
      server: server ?? null,
    };
  }

  return { id: op.id, kind: op.kind, status: "applied", version: result.version };
}

/**
 * Restore, and then the edit the reducer folded into it, in one request.
 *
 * `baseVersion` is the TOMBSTONE's version. Restoring bumps it, so the follow-up
 * update has to use the version restore just produced rather than the one the
 * client sent - which is the whole reason these are one op: the client has no way
 * to learn the intermediate version, and asking it to guess would make every
 * restore-and-replace conflict with itself.
 */
async function pushRestore(
  userId: string,
  op: Extract<PushOp, { kind: "expense.restore" }>,
): Promise<PushResult> {
  await assertParticipant(userId, op.id);

  const restored = await restoreExpense(op.id, userId, { expectedVersion: op.baseVersion });

  if (!op.payload) {
    if (restored.noop) {
      const [server] = await loadExpenses(db, [op.id]);
      return {
        id: op.id,
        kind: op.kind,
        status: "duplicate",
        version: restored.version,
        server: server ?? null,
      };
    }
    return { id: op.id, kind: op.kind, status: "applied", version: restored.version };
  }

  const { groupId = null, ...input } = op.payload;
  await assertMayWrite(userId, groupId, input.participants);

  const updated = await updateExpense(op.id, {
    ...input,
    groupId,
    details: input.details ?? null,
    categoryId: input.categoryId ?? null,
    updatedBy: userId,
    expectedVersion: restored.version,
  });

  return { id: op.id, kind: op.kind, status: "applied", version: updated.version };
}

/**
 * A comment.
 *
 * No `baseVersion`, because a comment has no version and must never bump the
 * expense's. `createComment` enforces the visibility rule itself and returns the
 * existing row for a known id, so a retry is a `duplicate` rather than a second
 * note.
 *
 * System comments are never pushed. There is no `kind` on the wire here at all,
 * and `createComment` defaults to `"user"`.
 */
async function pushCommentCreate(
  userId: string,
  op: Extract<PushOp, { kind: "comment.create" }>,
): Promise<PushResult> {
  const existing = await db
    .selectFrom("comments")
    .select("id")
    .where("id", "=", op.id)
    .executeTakeFirst();

  if (existing) {
    const [server] = await loadComments(db, [op.id]);
    return { id: op.id, kind: op.kind, status: "duplicate", server: server ?? null };
  }

  try {
    await createComment({
      id: op.id,
      expenseId: op.payload.expenseId,
      userId,
      content: op.payload.content,
    });
  } catch (err) {
    if (err instanceof CommentError && err.status === 404) {
      // Either the bill is not there yet - a comment sorted ahead of its own
      // expense, which `sortForPush` exists to prevent - or the caller can no
      // longer see it. Both are rejections with a reason, never silent drops.
      throw new Error("That expense is not available to comment on.");
    }
    throw err;
  }

  const [server] = await loadComments(db, [op.id]);
  return { id: op.id, kind: op.kind, status: "applied", server: server ?? null };
}

async function pushCommentDelete(
  userId: string,
  op: Extract<PushOp, { kind: "comment.delete" }>,
): Promise<PushResult> {
  const existing = await db
    .selectFrom("comments")
    .select(["id", "deleted_at"])
    .where("id", "=", op.id)
    .executeTakeFirst();

  // Gone already, or never arrived. Either way there is nothing left to do and the
  // client should clear the entry rather than retry forever.
  if (!existing || existing.deleted_at !== null) {
    return { id: op.id, kind: op.kind, status: "duplicate" };
  }

  await deleteComment(op.id, userId);
  return { id: op.id, kind: op.kind, status: "applied" };
}
