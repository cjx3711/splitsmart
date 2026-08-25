/**
 * Comments, through the real routes, on both shells.
 *
 * The properties worth pinning are the ones that would let a thread say something
 * untrue or reach somebody it should not:
 *
 *   - visibility is the same rule as GET /expenses/:id, and a stranger gets 404
 *     rather than 403 (a 403 confirms the expense exists)
 *   - a system comment cannot be written or deleted over HTTP, by anyone
 *   - only the author may delete their own note
 *   - editing, deleting and restoring a bill each leave a system row describing
 *     what happened, with the amounts formatted for the expense's currency
 *   - a guest link can read and write the thread of an expense it can see, and
 *     nothing else
 *   - commenting does not touch the ledger: no balance moves, no share changes
 *
 * DATABASE_PATH is set before importing anything that reaches src/db/index.ts,
 * which opens its connection at module load.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-comments-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense, updateExpense, deleteExpense, restoreExpense } = await import(
  "../../domain/expenses.ts"
);
const { createComment, describeExpenseChange, listComments } = await import(
  "../../domain/comments.ts"
);
const { mintAccessLink } = await import("../../domain/access-links.ts");
const { ulid } = await import("../../domain/ulid.ts");

/**
 * Alice and Bob share a group and a dinner. Carol has an account and no
 * connection to either of them. Ghost is a placeholder in the group, reachable
 * through a guest link.
 */
let aliceId: string;
let bobId: string;
let carolId: string;
let ghostId: string;
let groupId: string;
let expenseId: string;
let aliceToken: string;
let bobToken: string;
let carolToken: string;
let guestSecret: string;

async function realUser(name: string, email: string): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({
      id,
      email,
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      name,
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();
  return id;
}

async function as(token: string, path: string, init: RequestInit = {}) {
  const res = await app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function asGuest(path: string, init: RequestInit = {}) {
  const res = await app.request(`/api/v1/guest${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer link_${guestSecret}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  aliceId = await realUser("Alice", "alice@example.com");
  bobId = await realUser("Bob", "bob@example.com");
  carolId = await realUser("Carol", "carol@example.com");

  ghostId = ulid();
  await db
    .insertInto("users")
    .values({ id: ghostId, name: "Ghost", default_currency: "USD", is_ghost: 1 })
    .execute();

  groupId = ulid();
  await db
    .insertInto("groups")
    .values({ id: groupId, name: "Flat", default_currency: "USD", created_by: aliceId })
    .execute();
  for (const [userId, role] of [
    [aliceId, "owner"],
    [bobId, "member"],
    [ghostId, "member"],
  ] as const) {
    await db
      .insertInto("group_members")
      .values({ group_id: groupId, user_id: userId, role, joined_via: "added" })
      .execute();
  }

  expenseId = await createExpense({
    groupId,
    description: "Dinner",
    costMinor: 3000,
    currencyCode: "USD",
    date: "2026-03-01",
    splitType: "equal",
    participants: [
      { userId: aliceId, paidMinor: 3000 },
      { userId: bobId, paidMinor: 0 },
    ],
    createdBy: aliceId,
  });

  aliceToken = (await createApiToken(aliceId, "test")).token;
  bobToken = (await createApiToken(bobId, "test")).token;
  carolToken = (await createApiToken(carolId, "test")).token;

  const link = await mintAccessLink(db, {
    kind: "group_member",
    groupId,
    userId: ghostId,
    createdBy: aliceId,
  });
  guestSecret = link.secret;
});

after(async () => {
  await db.destroy();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("writing and reading a thread", () => {
  test("a participant can comment, and it comes back with its author", async () => {
    const posted = await as(aliceToken, `/expenses/${expenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "  I paid the tip in cash  " }),
    });

    assert.equal(posted.status, 201);
    assert.equal(posted.body.comment.content, "I paid the tip in cash", "content is trimmed");
    assert.equal(posted.body.comment.kind, "user");
    assert.equal(posted.body.comment.author.id, aliceId);
    assert.equal(posted.body.comment.author.name, "Alice");

    const listed = await as(bobToken, `/expenses/${expenseId}/comments`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.comments.length, 1);
  });

  test("a group member who is not on the bill can comment too", async () => {
    // The "why am I not on this?" case. Same rule as GET /expenses/:id.
    const ghostExpense = await createExpense({
      groupId,
      description: "Milk",
      costMinor: 500,
      currencyCode: "USD",
      date: "2026-03-02",
      splitType: "equal",
      participants: [{ userId: bobId, paidMinor: 500 }],
      createdBy: bobId,
    });

    const posted = await as(aliceToken, `/expenses/${ghostExpense}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "Was this for the flat?" }),
    });
    assert.equal(posted.status, 201);
    assert.equal((await as(aliceToken, `/expenses/${ghostExpense}`)).status, 200);
  });

  test("empty or whitespace content is a 400, not a row", async () => {
    const blank = await as(aliceToken, `/expenses/${expenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "   " }),
    });
    assert.equal(blank.status, 400);

    const rows = await db
      .selectFrom("comments")
      .select("id")
      .where("expense_id", "=", expenseId)
      .where("content", "=", "   ")
      .execute();
    assert.deepEqual(rows, []);
  });

  test("a stranger gets 404 on read and on write, never 403", async () => {
    // 403 would confirm the expense exists. Carol should not learn that.
    assert.equal((await as(carolToken, `/expenses/${expenseId}/comments`)).status, 404);
    assert.equal(
      (
        await as(carolToken, `/expenses/${expenseId}/comments`, {
          method: "POST",
          body: JSON.stringify({ content: "hello" }),
        })
      ).status,
      404,
    );
  });

  test("comments need authentication at all", async () => {
    const res = await app.request(`/api/v1/expenses/${expenseId}/comments`);
    assert.equal(res.status, 401);
  });

  test("commenting moves no money", async () => {
    const shares = await db
      .selectFrom("expense_users")
      .select(["user_id", "paid_share_minor", "owed_share_minor"])
      .where("expense_id", "=", expenseId)
      .execute();

    assert.equal(
      shares.reduce((sum, s) => sum + s.owed_share_minor, 0),
      3000,
    );
    // And the expense itself was not bumped into looking edited.
    const expense = await db
      .selectFrom("expenses")
      .select(["created_at", "updated_at"])
      .where("id", "=", expenseId)
      .executeTakeFirstOrThrow();
    assert.equal(expense.created_at, expense.updated_at, "a comment is not an edit");
  });
});

describe("deleting", () => {
  test("only the author may delete their own comment", async () => {
    const posted = await as(bobToken, `/expenses/${expenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "Bob was here" }),
    });
    const id = posted.body.comment.id;

    const byAlice = await as(aliceToken, `/comments/${id}`, { method: "DELETE" });
    assert.equal(byAlice.status, 403);

    const byBob = await as(bobToken, `/comments/${id}`, { method: "DELETE" });
    assert.equal(byBob.status, 200);
  });

  test("a deleted comment is a tombstone, not a hole in the table", async () => {
    const posted = await as(bobToken, `/expenses/${expenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "Temporary" }),
    });
    const id = posted.body.comment.id;
    await as(bobToken, `/comments/${id}`, { method: "DELETE" });

    const row = await db
      .selectFrom("comments")
      .select(["id", "deleted_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    assert.ok(row.deleted_at, "the row stays so merge and re-import matching still work");

    const listed = await as(bobToken, `/expenses/${expenseId}/comments`);
    assert.ok(!listed.body.comments.some((c: any) => c.id === id), "but it is not in the thread");
  });

  test("deleting twice is not an error", async () => {
    const posted = await as(bobToken, `/expenses/${expenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "Twice" }),
    });
    const id = posted.body.comment.id;
    assert.equal((await as(bobToken, `/comments/${id}`, { method: "DELETE" })).status, 200);
    assert.equal((await as(bobToken, `/comments/${id}`, { method: "DELETE" })).status, 200);
  });

  test("a stranger deleting gets 404, not 403", async () => {
    const posted = await as(bobToken, `/expenses/${expenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "Not yours" }),
    });
    assert.equal(
      (await as(carolToken, `/comments/${posted.body.comment.id}`, { method: "DELETE" })).status,
      404,
    );
  });
});

describe("system comments", () => {
  test("cannot be written over HTTP even by naming the kind", async () => {
    const posted = await as(aliceToken, `/expenses/${expenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "Pretending to be generated", kind: "system" }),
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.comment.kind, "user", "the body's kind is ignored, not honoured");
  });

  test("an edit leaves a note describing what changed", async () => {
    const target = await createExpense({
      groupId,
      description: "Taxi",
      costMinor: 2000,
      currencyCode: "USD",
      date: "2026-03-03",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 2000 },
        { userId: bobId, paidMinor: 0 },
      ],
      createdBy: aliceId,
    });

    await updateExpense(target, {
      groupId,
      description: "Taxi home",
      costMinor: 3000,
      currencyCode: "USD",
      date: "2026-03-03",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 3000 },
        { userId: bobId, paidMinor: 0 },
      ],
      updatedBy: bobId,
    });

    const comments = await listComments(db, target);
    const system = comments.filter((c) => c.kind === "system");
    assert.equal(system.length, 1);
    assert.match(system[0]!.content, /^Bob updated this expense:/);
    assert.match(system[0]!.content, /Amount: 20\.00 USD → 30\.00 USD/);
    assert.match(system[0]!.content, /Description: "Taxi" → "Taxi home"/);
    assert.match(system[0]!.content, /Alice's share: 10\.00 USD → 15\.00 USD/);
  });

  test("an edit that changes nothing writes no note", async () => {
    const target = await createExpense({
      groupId,
      description: "Same",
      costMinor: 1000,
      currencyCode: "USD",
      date: "2026-03-04",
      splitType: "equal",
      participants: [{ userId: aliceId, paidMinor: 1000 }],
      createdBy: aliceId,
    });

    const same = {
      groupId,
      description: "Same",
      costMinor: 1000,
      currencyCode: "USD",
      date: "2026-03-04",
      splitType: "equal" as const,
      participants: [{ userId: aliceId, paidMinor: 1000 }],
      updatedBy: aliceId,
    };
    await updateExpense(target, same);

    const comments = await listComments(db, target);
    assert.deepEqual(comments, []);
  });

  test("delete and restore both leave a note, and neither is deletable", async () => {
    const target = await createExpense({
      groupId,
      description: "Doomed",
      costMinor: 1000,
      currencyCode: "USD",
      date: "2026-03-05",
      splitType: "equal",
      participants: [{ userId: aliceId, paidMinor: 1000 }],
      createdBy: aliceId,
    });

    await deleteExpense(target, aliceId);
    await restoreExpense(target, bobId);

    const comments = await listComments(db, target);
    const contents = comments.map((c) => c.content);
    assert.ok(contents.includes("Alice deleted this expense."));
    assert.ok(contents.includes("Bob restored this expense."));

    const systemId = comments.find((c) => c.kind === "system")!.id;
    const attempt = await as(aliceToken, `/comments/${systemId}`, { method: "DELETE" });
    assert.equal(attempt.status, 403);
    assert.match(attempt.body.error, /cannot be deleted/i);
  });

  test("a zero-decimal currency is formatted as itself, not divided by 100", async () => {
    const target = await createExpense({
      groupId,
      description: "Ramen",
      costMinor: 3400,
      currencyCode: "JPY",
      date: "2026-03-06",
      splitType: "equal",
      participants: [{ userId: aliceId, paidMinor: 3400 }],
      createdBy: aliceId,
    });

    await updateExpense(target, {
      groupId,
      description: "Ramen",
      costMinor: 3500,
      currencyCode: "JPY",
      date: "2026-03-06",
      splitType: "equal",
      participants: [{ userId: aliceId, paidMinor: 3500 }],
      updatedBy: aliceId,
    });

    const system = (await listComments(db, target)).find((c) => c.kind === "system")!;
    assert.match(system.content, /Amount: 3400 JPY → 3500 JPY/);
  });
});

describe("describeExpenseChange", () => {
  const base = {
    description: "Dinner",
    details: null,
    amount: "25.00 USD",
    date: "2026-03-01",
    category: "Dining out",
    group: "Flat",
    isPayment: false,
    shares: [{ name: "Alice", owed: "12.50 USD" }, { name: "Bob", owed: "12.50 USD" }],
    repeat: null,
  };

  test("says nothing when nothing changed", () => {
    assert.deepEqual(describeExpenseChange(base, { ...base }), []);
  });

  test("names people added and removed", () => {
    const after = {
      ...base,
      shares: [
        { name: "Alice", owed: "8.34 USD" },
        { name: "Carol", owed: "8.33 USD" },
        { name: "Dana", owed: "8.33 USD" },
      ],
    };
    const lines = describeExpenseChange(base, after);
    assert.ok(lines.some((l) => l === "Added Carol, owing 8.33 USD"));
    assert.ok(lines.some((l) => l === "Added Dana, owing 8.33 USD"));
    assert.ok(lines.some((l) => l === "Removed Bob"));
    assert.ok(lines.some((l) => l === "Alice's share: 12.50 USD → 8.34 USD"));
  });

  test("describes a move between groups in both directions", () => {
    assert.ok(
      describeExpenseChange(base, { ...base, group: null }).includes(
        "Moved out of Flat into one-on-one expenses",
      ),
    );
    assert.ok(
      describeExpenseChange({ ...base, group: null }, base).includes("Moved into Flat"),
    );
    assert.ok(
      describeExpenseChange(base, { ...base, group: "Trip" }).includes("Moved from Flat to Trip"),
    );
  });

  test("describes a schedule appearing and disappearing", () => {
    assert.ok(describeExpenseChange(base, { ...base, repeat: "monthly" }).includes("Now repeats monthly"));
    assert.ok(describeExpenseChange({ ...base, repeat: "monthly" }, base).includes("No longer repeats"));
  });

  test("flattens and truncates long text rather than storing a wall of it", () => {
    const long = "x".repeat(400);
    const lines = describeExpenseChange(base, { ...base, description: long });
    assert.ok(lines[0]!.length < 300);
    assert.ok(lines[0]!.includes("…"));
  });
});

describe("through a guest link", () => {
  /**
   * A bill the ghost is actually on, plus the group dinner they are not on.
   *
   * Guest visibility for a group is the same as logged-in: every bill in the
   * groups the link covers, not only the ones the ghost is named on. 1:1 bills
   * stay out of a group link (`expenseInScope`).
   */
  let ghostExpenseId: string;

  before(async () => {
    ghostExpenseId = await createExpense({
      groupId,
      description: "Ghost's share of the milk",
      costMinor: 900,
      currencyCode: "USD",
      date: "2026-03-09",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 900 },
        { userId: ghostId, paidMinor: 0 },
      ],
      createdBy: aliceId,
    });
  });

  test("a guest reads and writes the thread of an expense in scope", async () => {
    const posted = await asGuest(`/expenses/${ghostExpenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "Was this the Thai place?" }),
    });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.comment.author.id, ghostId, "a guest speaks as the person the link is for");

    const listed = await asGuest(`/expenses/${ghostExpenseId}/comments`);
    assert.equal(listed.status, 200);
    assert.ok(listed.body.comments.some((c: any) => c.content === "Was this the Thai place?"));
  });

  test("a guest may delete their own note and nobody else's", async () => {
    const mine = await asGuest(`/expenses/${ghostExpenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "Mine" }),
    });
    assert.equal(
      (await asGuest(`/comments/${mine.body.comment.id}`, { method: "DELETE" })).status,
      200,
    );

    const alices = await as(aliceToken, `/expenses/${ghostExpenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "Alice's own" }),
    });
    assert.equal(
      (await asGuest(`/comments/${alices.body.comment.id}`, { method: "DELETE" })).status,
      403,
    );
  });

  test("a guest can read and write the thread of a group bill they are not on", async () => {
    assert.equal((await asGuest(`/expenses/${expenseId}/comments`)).status, 200);
    const posted = await asGuest(`/expenses/${expenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content: "Was this for the flat?" }),
    });
    assert.equal(posted.status, 201);
  });

  test("a guest cannot reach a thread outside the link's scope", async () => {
    // A 1:1 expense between Alice and Bob: no group, so a group_member link has
    // no way in. `expenseInScope` is the single rule that decides this.
    const private_ = await createExpense({
      groupId: null,
      description: "Just us",
      costMinor: 1000,
      currencyCode: "USD",
      date: "2026-03-07",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 1000 },
        { userId: bobId, paidMinor: 0 },
      ],
      createdBy: aliceId,
    });

    assert.equal((await asGuest(`/expenses/${private_}/comments`)).status, 404);
    assert.equal(
      (
        await asGuest(`/expenses/${private_}/comments`, {
          method: "POST",
          body: JSON.stringify({ content: "peeking" }),
        })
      ).status,
      404,
    );
  });

  test("a session cookie or API token is not a guest credential and vice versa", async () => {
    // The link token must never work on /api/v1 proper...
    const onNative = await app.request(`/api/v1/expenses/${expenseId}/comments`, {
      headers: { Authorization: `Bearer link_${guestSecret}` },
    });
    assert.equal(onNative.status, 401);

    // ...and an API token must not work on the guest tree.
    const onGuest = await app.request(`/api/v1/guest/expenses/${expenseId}/comments`, {
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    assert.equal(onGuest.status, 401);
  });
});

describe("comment counts on list rows", () => {
  test("the list endpoints carry a live count", async () => {
    const counted = await createExpense({
      groupId,
      description: "Counted",
      costMinor: 1000,
      currencyCode: "USD",
      date: "2026-03-08",
      splitType: "equal",
      participants: [{ userId: aliceId, paidMinor: 1000 }],
      createdBy: aliceId,
    });

    const first = await createComment({
      expenseId: counted,
      userId: aliceId,
      content: "One",
    });
    await createComment({ expenseId: counted, userId: bobId, content: "Two" });

    const list = await as(aliceToken, "/expenses");
    const row = list.body.expenses.find((e: any) => e.id === counted);
    assert.equal(row.comment_count, 2);

    const group = await as(aliceToken, `/groups/${groupId}/expenses`);
    assert.equal(group.body.expenses.find((e: any) => e.id === counted).comment_count, 2);

    // A tombstoned comment stops counting.
    await as(aliceToken, `/comments/${first}`, { method: "DELETE" });
    const after = await as(aliceToken, "/expenses");
    assert.equal(after.body.expenses.find((e: any) => e.id === counted).comment_count, 1);
  });

  test("commenting shows up in the activity feed", async () => {
    const feed = await as(aliceToken, "/activity");
    assert.ok(
      feed.body.activity.some((entry: any) => entry.action === "comment.created"),
      "a live comment is a feed event; an imported one is not",
    );
  });
});
