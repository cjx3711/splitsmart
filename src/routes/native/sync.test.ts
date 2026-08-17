/**
 * `/api/v1/sync/*` through the real routes, the real writers and a real database.
 *
 * Follows src/routes/native/import.test.ts: no mocks, `DATABASE_PATH` set before
 * anything reaches src/db/index.ts. What is pinned here is the list from
 * docs/OFFLINE.md's Testing section, because every item on it is a way for money
 * to go quietly missing between two devices:
 *
 *   push idempotency, push order, conflict, delete-wins, restore, rejection,
 *   audience, join catch-up, non-group catch-up, leave/forget, comments, the
 *   scheduler, claim/merge, and the cursor across a page boundary.
 *
 * Plus the two structural rules: `/sync` refuses a guest link, and the invariant
 * still holds after every replay.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-sync-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense, deleteExpense, updateExpense } = await import("../../domain/expenses.ts");
const { createComment } = await import("../../domain/comments.ts");
const { mergeUsers } = await import("../../domain/merge.ts");
const { runDueRecurrences } = await import("../../domain/scheduler.ts");
const { mintAccessLink } = await import("../../domain/access-links.ts");
const { ulid } = await import("../../domain/ulid.ts");

let aliceId: string;
let bobId: string;
let carolId: string;
let groupId: string;
let aliceToken: string;
let bobToken: string;
let carolToken: string;

async function realUser(name: string, email: string): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({
      id,
      email,
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      first_name: name,
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();
  return id;
}

async function ghostUser(name: string): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({ id, first_name: name, default_currency: "USD", is_ghost: 1 })
    .execute();
  return id;
}

async function makeGroup(name: string, members: string[]): Promise<string> {
  const id = ulid();
  await db.insertInto("groups").values({ id, name, created_by: members[0]! }).execute();
  for (const [index, userId] of members.entries()) {
    await db
      .insertInto("group_members")
      .values({
        group_id: id,
        user_id: userId,
        role: index === 0 ? "owner" : "member",
        joined_via: index === 0 ? "creator" : "added",
      })
      .execute();
  }
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

/** An equal split among the named people, first payer fronts the lot. */
function expenseBody(
  participants: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    description: "Dinner",
    costMinor: 3000,
    currencyCode: "USD",
    date: "2026-04-01",
    splitType: "equal",
    participants: participants.map((userId, i) => ({
      userId,
      paidMinor: i === 0 ? 3000 : 0,
    })),
    ...overrides,
  };
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  aliceId = await realUser("Alice", "alice@example.com");
  bobId = await realUser("Bob", "bob@example.com");
  carolId = await realUser("Carol", "carol@example.com");
  groupId = await makeGroup("Flat", [aliceId, bobId]);

  aliceToken = (await createApiToken(aliceId, "test")).token;
  bobToken = (await createApiToken(bobId, "test")).token;
  carolToken = (await createApiToken(carolId, "test")).token;
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("access", () => {
  test("a guest link cannot reach the sync tree", async () => {
    const ghost = await ghostUser("Placeholder");
    await db
      .insertInto("group_members")
      .values({ group_id: groupId, user_id: ghost, role: "member", joined_via: "added" })
      .execute();

    const link = await mintAccessLink(db, {
      kind: "group_member",
      groupId,
      userId: ghost,
      createdBy: aliceId,
    });

    for (const path of ["/sync/bootstrap", "/sync/pull?since=0"]) {
      const res = await app.request(`/api/v1${path}`, {
        headers: { Authorization: `Bearer link_${link.secret}` },
      });
      assert.equal(res.status, 401);
      assert.equal(((await res.json()) as any).guestLink, true);
    }
  });

  test("no credential at all is a 401", async () => {
    const res = await app.request("/api/v1/sync/bootstrap");
    assert.equal(res.status, 401);
  });
});

describe("bootstrap", () => {
  test("carries the caller's ledger and the reference data it cannot render without", async () => {
    await createExpense({
      ...(expenseBody([aliceId, bobId]) as any),
      groupId,
      createdBy: aliceId,
    });

    const { status, body } = await as(aliceToken, "/sync/bootstrap");

    assert.equal(status, 200);
    assert.equal(typeof body.seq, "number");
    assert.equal(body.self.id, aliceId);
    assert.ok(body.groups.some((g: any) => g.id === groupId));
    assert.ok(body.expenses.length >= 1);
    // Without these the money components render dashes rather than amounts.
    assert.ok(body.currencies.length > 100);
    assert.ok(body.categories.length > 10);
    assert.equal(body.nextCursor, null);
  });

  test("an expense carries its shares and the people it names", async () => {
    const { body } = await as(aliceToken, "/sync/bootstrap");
    const expense = body.expenses[0];

    assert.equal(expense.shares.length, 2);
    assert.deepEqual(
      expense.people.map((p: any) => p.id).sort(),
      [aliceId, bobId].sort(),
    );
    assert.equal(typeof expense.version, "number");
  });

  test("a stranger sees none of it", async () => {
    const { body } = await as(carolToken, "/sync/bootstrap");
    assert.deepEqual(body.expenses, []);
    assert.deepEqual(body.groups, []);
  });
});

describe("pull", () => {
  test("delivers a group expense to a member and not to anybody else", async () => {
    const before = (await as(aliceToken, "/sync/pull?since=0")).body.seq;

    await createExpense({
      ...(expenseBody([aliceId, bobId], { description: "Audience test" }) as any),
      groupId,
      createdBy: aliceId,
    });

    const mine = await as(bobToken, `/sync/pull?since=${before}`);
    assert.ok(
      mine.body.changes.some(
        (ch: any) => ch.entity === "expense" && ch.data.description === "Audience test",
      ),
    );

    const stranger = await as(carolToken, `/sync/pull?since=${before}`);
    assert.deepEqual(stranger.body.changes, []);
  });

  test("collapses several edits of one bill into its current state", async () => {
    const id = ulid();
    await createExpense({
      ...(expenseBody([aliceId, bobId]) as any),
      id,
      groupId,
      createdBy: aliceId,
    });

    const since = (await as(aliceToken, "/sync/pull?since=0")).body.seq;

    for (const cost of [4000, 5000, 6000]) {
      await updateExpense(id, {
        ...(expenseBody([aliceId, bobId], { costMinor: cost }) as any),
        participants: [
          { userId: aliceId, paidMinor: cost },
          { userId: bobId, paidMinor: 0 },
        ],
        groupId,
        updatedBy: aliceId,
      });
    }

    const { body } = await as(bobToken, `/sync/pull?since=${since}`);
    const forThis = body.changes.filter(
      (ch: any) => ch.entity === "expense" && ch.data.id === id,
    );

    assert.equal(forThis.length, 1, "one entity, one change");
    assert.equal(forThis[0].data.costMinor, 6000, "and it is the final state");
  });

  test("a delete arrives as a tombstone, not a disappearance", async () => {
    const id = ulid();
    await createExpense({
      ...(expenseBody([aliceId, bobId]) as any),
      id,
      groupId,
      createdBy: aliceId,
    });
    const since = (await as(aliceToken, "/sync/pull?since=0")).body.seq;

    await deleteExpense(id, aliceId);

    const { body } = await as(bobToken, `/sync/pull?since=${since}`);
    const change = body.changes.find((ch: any) => ch.entity === "expense" && ch.data.id === id);
    assert.equal(change.op, "delete");
    assert.notEqual(change.data.deletedAt, null);
  });

  test("is complete and non-duplicating across a page boundary", async () => {
    const since = (await as(aliceToken, "/sync/pull?since=0")).body.seq;
    const ids: string[] = [];

    for (let i = 0; i < 5; i++) {
      const id = ulid();
      ids.push(id);
      await createExpense({
        ...(expenseBody([aliceId, bobId], { description: `Paged ${i}` }) as any),
        id,
        groupId,
        createdBy: aliceId,
      });
    }

    const seen = new Set<string>();
    let cursor = since;
    let pages = 0;

    // limit=2 forces the boundary that a real 1000-row page almost never hits.
    for (;;) {
      const { body } = await as(bobToken, `/sync/pull?since=${cursor}&limit=2`);
      pages++;
      for (const change of body.changes) {
        if (change.entity !== "expense") continue;
        assert.equal(seen.has(change.data.id), false, "a row must not arrive twice");
        seen.add(change.data.id);
      }
      cursor = body.seq;
      if (!body.more) break;
      assert.ok(pages < 20, "pagination must terminate");
    }

    assert.ok(pages > 1, "the test is worthless if it all fitted in one page");
    for (const id of ids) assert.ok(seen.has(id), `${id} must have arrived`);
  });

  test("a system comment appears after an edit, and is never pushable", async () => {
    const id = ulid();
    await createExpense({
      ...(expenseBody([aliceId, bobId]) as any),
      id,
      groupId,
      createdBy: aliceId,
    });
    const since = (await as(aliceToken, "/sync/pull?since=0")).body.seq;

    await updateExpense(id, {
      ...(expenseBody([aliceId, bobId], { description: "Dinner and drinks" }) as any),
      groupId,
      updatedBy: aliceId,
    });

    const { body } = await as(bobToken, `/sync/pull?since=${since}`);
    const system = body.changes.find(
      (ch: any) => ch.entity === "comment" && ch.data.kind === "system",
    );
    assert.ok(system, "the generated sentence has to reach other devices");

    // And there is no way to send one: `kind` is not on the push wire at all.
    const push = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "comment.create",
            id: ulid(),
            payload: { expenseId: id, content: "note", kind: "system" },
          },
        ],
      }),
    });
    assert.equal(push.body.results[0].status, "applied");
    const stored = await db
      .selectFrom("comments")
      .select("kind")
      .where("id", "=", push.body.results[0].id)
      .executeTakeFirstOrThrow();
    assert.equal(stored.kind, "user", "an extra field on the wire cannot make a system row");
  });
});

describe("push", () => {
  test("a client-minted create applies, and replaying it is a duplicate with the stored row", async () => {
    const id = ulid();
    const ops = [{ kind: "expense.create", id, payload: { ...expenseBody([aliceId, bobId]), groupId } }];

    const first = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({ ops }),
    });
    assert.equal(first.body.results[0].status, "applied");
    assert.equal(first.body.results[0].version, 1);

    const second = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({ ops }),
    });
    assert.equal(second.body.results[0].status, "duplicate");
    assert.equal(second.body.results[0].server.id, id, "the stored row, not just the id");
    assert.equal(second.body.results[0].server.costMinor, 3000);

    const count = await db
      .selectFrom("expenses")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    assert.equal(Number(count.n), 1, "one expense, not two");
  });

  test("a payment create is an expense with is_payment set", async () => {
    const id = ulid();
    const { body } = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "payment.create",
            id,
            payload: {
              description: "Payment",
              costMinor: 1500,
              currencyCode: "USD",
              date: "2026-04-02",
              splitType: "exact",
              groupId,
              participants: [
                { userId: aliceId, paidMinor: 1500, input: 0 },
                { userId: bobId, paidMinor: 0, input: 1500 },
              ],
            },
          },
        ],
      }),
    });

    assert.equal(body.results[0].status, "applied");
    const row = await db
      .selectFrom("expenses")
      .select("is_payment")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    assert.equal(row.is_payment, 1);
  });

  test("a comment before its own expense is rejected; the sorted batch applies both", async () => {
    const expenseId = ulid();
    const commentId = ulid();

    const wrongOrder = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({
        ops: [
          { kind: "comment.create", id: commentId, payload: { expenseId, content: "first!" } },
          {
            kind: "expense.create",
            id: expenseId,
            payload: { ...expenseBody([aliceId, bobId]), groupId },
          },
        ],
      }),
    });

    assert.equal(wrongOrder.body.results[0].status, "rejected");
    assert.match(wrongOrder.body.results[0].reason, /not available to comment on/);
    assert.equal(wrongOrder.body.results[1].status, "applied");

    // sortForPush (web/src/sync/outbox.ts) is what puts creates first. Retrying the
    // comment now that its parent exists succeeds.
    const retry = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({
        ops: [{ kind: "comment.create", id: commentId, payload: { expenseId, content: "first!" } }],
      }),
    });
    assert.equal(retry.body.results[0].status, "applied");
  });

  test("a stale baseVersion is a conflict that carries the server's row, and moves no money", async () => {
    const id = ulid();
    await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "expense.create",
            id,
            payload: { ...expenseBody([aliceId, bobId]), groupId },
          },
        ],
      }),
    });

    // Bob edits first, from version 1.
    const bobPush = await as(bobToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "expense.update",
            id,
            baseVersion: 1,
            payload: {
              ...expenseBody([aliceId, bobId], { costMinor: 8000 }),
              participants: [
                { userId: aliceId, paidMinor: 8000 },
                { userId: bobId, paidMinor: 0 },
              ],
              groupId,
            },
          },
        ],
      }),
    });
    assert.equal(bobPush.body.results[0].status, "applied");
    assert.equal(bobPush.body.results[0].version, 2);

    // Alice was offline and still thinks it is version 1.
    const alicePush = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "expense.update",
            id,
            baseVersion: 1,
            payload: {
              ...expenseBody([aliceId, bobId], { costMinor: 100 }),
              participants: [
                { userId: aliceId, paidMinor: 100 },
                { userId: bobId, paidMinor: 0 },
              ],
              groupId,
            },
          },
        ],
      }),
    });

    const result = alicePush.body.results[0];
    assert.equal(result.status, "conflict");
    assert.equal(result.version, 2);
    assert.equal(result.server.costMinor, 8000, "the server's row travels back");

    const row = await db
      .selectFrom("expenses")
      .select(["cost_minor", "version"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    assert.equal(row.cost_minor, 8000);
    assert.equal(row.version, 2);
  });

  test("delete-wins: an edit pushed on top of somebody else's delete cannot resurrect it", async () => {
    const id = ulid();
    await createExpense({
      ...(expenseBody([aliceId, bobId]) as any),
      id,
      groupId,
      createdBy: aliceId,
    });
    await deleteExpense(id, bobId); // 1 -> 2

    const { body } = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "expense.update",
            id,
            baseVersion: 1,
            payload: { ...expenseBody([aliceId, bobId]), groupId },
          },
        ],
      }),
    });

    // `updateExpense` refuses a deleted row before the version check, so this is a
    // rejection with a reason rather than the edit/edit prompt. Either way the
    // tombstone stands.
    assert.equal(body.results[0].status, "rejected");
    const row = await db
      .selectFrom("expenses")
      .select("deleted_at")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    assert.notEqual(row.deleted_at, null);
  });

  test("restore bumps the version and can carry the edit folded into it", async () => {
    const id = ulid();
    await createExpense({
      ...(expenseBody([aliceId, bobId]) as any),
      id,
      groupId,
      createdBy: aliceId,
    });
    await deleteExpense(id, aliceId); // -> 2

    const { body } = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "expense.restore",
            id,
            baseVersion: 2,
            payload: {
              ...expenseBody([aliceId, bobId], { costMinor: 4500, description: "Restored" }),
              participants: [
                { userId: aliceId, paidMinor: 4500 },
                { userId: bobId, paidMinor: 0 },
              ],
              groupId,
            },
          },
        ],
      }),
    });

    // Restore bumps to 3, the folded update to 4. The FINAL version comes back,
    // because the client has no way to learn the one in between.
    assert.equal(body.results[0].status, "applied");
    assert.equal(body.results[0].version, 4);

    const row = await db
      .selectFrom("expenses")
      .select(["deleted_at", "cost_minor", "description", "version"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    assert.equal(row.deleted_at, null);
    assert.equal(row.cost_minor, 4500);
    assert.equal(row.description, "Restored");
    assert.equal(row.version, 4);
  });

  test("restoring a live row is a duplicate, not an error", async () => {
    const id = ulid();
    await createExpense({
      ...(expenseBody([aliceId, bobId]) as any),
      id,
      groupId,
      createdBy: aliceId,
    });

    const { body } = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({ ops: [{ kind: "expense.restore", id, baseVersion: 1 }] }),
    });
    assert.equal(body.results[0].status, "duplicate");
  });

  test("deleting a comment twice is a duplicate", async () => {
    const expenseId = ulid();
    await createExpense({
      ...(expenseBody([aliceId, bobId]) as any),
      id: expenseId,
      groupId,
      createdBy: aliceId,
    });
    const commentId = await createComment({ expenseId, userId: aliceId, content: "note" });

    const body = (ops: unknown) => JSON.stringify({ ops });
    const first = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: body([{ kind: "comment.delete", id: commentId }]),
    });
    assert.equal(first.body.results[0].status, "applied");

    const second = await as(aliceToken, "/sync/push", {
      method: "POST",
      body: body([{ kind: "comment.delete", id: commentId }]),
    });
    assert.equal(second.body.results[0].status, "duplicate");
  });

  test("a comment op does not change the expense's version", async () => {
    const expenseId = ulid();
    await createExpense({
      ...(expenseBody([aliceId, bobId]) as any),
      id: expenseId,
      groupId,
      createdBy: aliceId,
    });

    await as(aliceToken, "/sync/push", {
      method: "POST",
      body: JSON.stringify({
        ops: [
          {
            kind: "comment.create",
            id: ulid(),
            payload: { expenseId, content: "does not touch the ledger" },
          },
        ],
      }),
    });

    const row = await db
      .selectFrom("expenses")
      .select("version")
      .where("id", "=", expenseId)
      .executeTakeFirstOrThrow();
    assert.equal(row.version, 1);
  });

  describe("rejections", () => {
    test("an unknown currency writes nothing and says why", async () => {
      const id = ulid();
      const { body } = await as(aliceToken, "/sync/push", {
        method: "POST",
        body: JSON.stringify({
          ops: [
            {
              kind: "expense.create",
              id,
              payload: { ...expenseBody([aliceId, bobId], { currencyCode: "ZZZ" }), groupId },
            },
          ],
        }),
      });

      assert.equal(body.results[0].status, "rejected");
      assert.ok(body.results[0].reason);
      const row = await db
        .selectFrom("expenses")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst();
      assert.equal(row, undefined);
    });

    test("a stranger on a group bill is refused", async () => {
      const { body } = await as(aliceToken, "/sync/push", {
        method: "POST",
        body: JSON.stringify({
          ops: [
            {
              kind: "expense.create",
              id: ulid(),
              payload: { ...expenseBody([aliceId, carolId]), groupId },
            },
          ],
        }),
      });
      assert.equal(body.results[0].status, "rejected");
    });

    test("pushing a create for a group you have since left is rejected, not coerced", async () => {
      const leaver = await realUser("Leaver", "leaver@example.com");
      const token = (await createApiToken(leaver, "test")).token;
      const temp = await makeGroup("Temporary", [aliceId, leaver]);

      // Made while still a member, queued, and then they left.
      const id = ulid();
      await db
        .updateTable("group_members")
        .set({ left_at: new Date().toISOString() })
        .where("group_id", "=", temp)
        .where("user_id", "=", leaver)
        .execute();

      const { body } = await as(token, "/sync/push", {
        method: "POST",
        body: JSON.stringify({
          ops: [
            {
              kind: "expense.create",
              id,
              payload: { ...expenseBody([leaver, aliceId]), groupId: temp },
            },
          ],
        }),
      });

      assert.equal(body.results[0].status, "rejected");
      assert.match(body.results[0].reason, /no longer a member/);

      // NOT quietly moved out of the group into a non-group expense.
      const row = await db
        .selectFrom("expenses")
        .select("id")
        .where("id", "=", id)
        .executeTakeFirst();
      assert.equal(row, undefined);
    });

    test("shares that do not sum to the cost are refused", async () => {
      const { body } = await as(aliceToken, "/sync/push", {
        method: "POST",
        body: JSON.stringify({
          ops: [
            {
              kind: "expense.create",
              id: ulid(),
              payload: {
                ...expenseBody([aliceId, bobId], { splitType: "exact" }),
                participants: [
                  { userId: aliceId, paidMinor: 3000, input: 1000 },
                  { userId: bobId, paidMinor: 0, input: 1000 },
                ],
                groupId,
              },
            },
          ],
        }),
      });
      assert.equal(body.results[0].status, "rejected");
    });
  });
});

describe("catch-up", () => {
  test("joining a group delivers the membership row plus a group snapshot", async () => {
    const joiner = await realUser("Joiner", "joiner@example.com");
    const token = (await createApiToken(joiner, "test")).token;
    const history = await makeGroup("Has history", [aliceId, bobId]);

    // Alice may only add somebody she can already see, so that the endpoint is not
    // a way to attach a stranger's account to your ledger by guessing a ULID.
    await as(aliceToken, "/friends", {
      method: "POST",
      body: JSON.stringify({ firstName: "Joiner", email: "joiner@example.com" }),
    });

    // Three bills and a thread, all written before the joiner exists as a member.
    for (let i = 0; i < 3; i++) {
      const id = ulid();
      await createExpense({
        ...(expenseBody([aliceId, bobId], { description: `Old ${i}` }) as any),
        id,
        groupId: history,
        createdBy: aliceId,
      });
      await createComment({ expenseId: id, userId: aliceId, content: `note ${i}` });
    }

    // The joiner is already syncing, so their cursor is past all of that.
    const since = (await as(token, "/sync/pull?since=0")).body.seq;

    const added = await as(aliceToken, `/groups/${history}/members`, {
      method: "POST",
      body: JSON.stringify({ userId: joiner }),
    });
    assert.equal(added.status, 201);

    const pull = await as(token, `/sync/pull?since=${since}`);
    assert.deepEqual(pull.body.catchUp, [{ entity: "group", id: history }]);

    const snapshot = await as(token, `/sync/snapshot?group_id=${history}`);
    assert.equal(snapshot.status, 200);
    assert.equal(snapshot.body.expenses.length, 3, "all of it, not just what changed");
    assert.equal(snapshot.body.comments.length, 3, "threads included");
    assert.ok(snapshot.body.members.length >= 3);
  });

  test("being added to a non-group bill delivers the expense and a thread catch-up", async () => {
    const invitee = await realUser("Invitee", "invitee@example.com");
    const token = (await createApiToken(invitee, "test")).token;

    // Alice and Bob's own bill, with a conversation on it.
    const id = ulid();
    await createExpense({
      ...(expenseBody([aliceId, bobId], { description: "Taxi" }) as any),
      id,
      groupId: null,
      createdBy: aliceId,
    });
    await createComment({ expenseId: id, userId: bobId, content: "I have the receipt" });

    // The invitee has to share history with Alice for a non-group expense to be
    // allowed at all. A separate group does that without touching this bill.
    await makeGroup("Shared", [aliceId, invitee]);
    const since = (await as(token, "/sync/pull?since=0")).body.seq;

    await updateExpense(id, {
      ...(expenseBody([aliceId, bobId], { description: "Taxi" }) as any),
      participants: [
        { userId: aliceId, paidMinor: 3000 },
        { userId: bobId, paidMinor: 0 },
        { userId: invitee, paidMinor: 0 },
      ],
      groupId: null,
      updatedBy: aliceId,
    });

    const pull = await as(token, `/sync/pull?since=${since}`);

    // The expense upsert alone is NOT this test: its comments have seqs far below
    // the cursor, so without the catch-up the bill lands with an empty thread.
    assert.ok(
      pull.body.changes.some((ch: any) => ch.entity === "expense" && ch.data.id === id),
    );
    assert.deepEqual(pull.body.catchUp, [{ entity: "expense", id }]);

    const snapshot = await as(token, `/sync/snapshot?expense_id=${id}`);
    assert.equal(snapshot.status, 200);
    // Bob's note plus the system sentence the edit itself generated. The one that
    // matters is Bob's: its seq is far below the cursor and only the snapshot
    // could have delivered it.
    assert.ok(
      snapshot.body.comments.some((cm: any) => cm.content === "I have the receipt"),
    );
  });

  test("a snapshot of somebody else's group is a 404", async () => {
    const res = await as(carolToken, `/sync/snapshot?group_id=${groupId}`);
    assert.equal(res.status, 404);
  });

  test("exactly one of group_id or expense_id is required", async () => {
    assert.equal((await as(aliceToken, "/sync/snapshot")).status, 400);
    assert.equal(
      (await as(aliceToken, `/sync/snapshot?group_id=${groupId}&expense_id=${ulid()}`)).status,
      400,
    );
  });
});

describe("leaving and forgetting", () => {
  test("being removed from a non-group bill delivers a forget", async () => {
    const dropped = await realUser("Dropped", "dropped@example.com");
    const token = (await createApiToken(dropped, "test")).token;
    await makeGroup("Bridge", [aliceId, dropped]);

    const id = ulid();
    await createExpense({
      ...(expenseBody([aliceId, dropped], { description: "Museum" }) as any),
      id,
      groupId: null,
      createdBy: aliceId,
    });

    const since = (await as(token, "/sync/pull?since=0")).body.seq;

    await updateExpense(id, {
      ...(expenseBody([aliceId, bobId], { description: "Museum" }) as any),
      participants: [
        { userId: aliceId, paidMinor: 3000 },
        { userId: bobId, paidMinor: 0 },
      ],
      groupId: null,
      updatedBy: aliceId,
    });

    const { body } = await as(token, `/sync/pull?since=${since}`);
    const forget = body.changes.find((ch: any) => ch.op === "forget");
    assert.ok(forget, "otherwise the row sits in their ledger forever");
    assert.equal(forget.entity, "expense");
    assert.deepEqual(forget.data, { id }, "a forget carries the id and nothing else");
  });

  test("leaving a group delivers your own membership row", async () => {
    const leaver = await realUser("Departing", "departing@example.com");
    const token = (await createApiToken(leaver, "test")).token;
    const temp = await makeGroup("Weekend", [aliceId, leaver]);

    const since = (await as(token, "/sync/pull?since=0")).body.seq;

    const removed = await as(aliceToken, `/groups/${temp}/members/${leaver}`, {
      method: "DELETE",
    });
    assert.equal(removed.status, 200);

    // After `left_at` they no longer match the membership clause, so this row can
    // only reach them through `entity = 'group_member' AND entity_id = :me`.
    const { body } = await as(token, `/sync/pull?since=${since}`);
    const change = body.changes.find(
      (ch: any) => ch.entity === "group_member" && ch.data?.userId === leaver,
    );
    assert.ok(change, "without it they would never learn they had left");
    assert.notEqual(change.data.leftAt, null);
    assert.deepEqual(body.catchUp, [], "being removed is not an access grant");
  });
});

describe("the scheduler", () => {
  test("an occurrence reaches another device, and the template's version is untouched", async () => {
    const templateId = ulid();
    await createExpense({
      id: templateId,
      groupId,
      description: "Rent",
      costMinor: 100000,
      currencyCode: "USD",
      date: "2026-01-01",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 100000 },
        { userId: bobId, paidMinor: 0 },
      ],
      repeatInterval: "monthly",
      createdBy: aliceId,
    });

    const since = (await as(bobToken, "/sync/pull?since=0")).body.seq;

    const run = await runDueRecurrences(new Date("2026-03-01T00:00:00Z"));
    assert.equal(run.generated.length, 1);

    const { body } = await as(bobToken, `/sync/pull?since=${since}`);
    const occurrence = body.changes.find(
      (ch: any) => ch.entity === "expense" && ch.data?.repeatOf === templateId,
    );
    assert.ok(occurrence, "the new bill has to arrive");

    const template = body.changes.find(
      (ch: any) => ch.entity === "expense" && ch.data?.id === templateId,
    );
    assert.ok(template, "and so does the moved schedule");
    assert.equal(template.data.version, 1, "a tick is not an edit");
  });
});

describe("claim / merge", () => {
  test("the ghost is gone, the shares are the server's, and the survivor catches up", async () => {
    const owner = await realUser("Owner", "owner@example.com");
    const claimer = await realUser("Claimer", "claimer@example.com");
    const claimerToken = (await createApiToken(claimer, "test")).token;
    const ghost = await ghostUser("Placeholder");

    const trip = await makeGroup("Trip", [owner, ghost]);
    const shared = ulid();
    await createExpense({
      id: shared,
      groupId: trip,
      description: "Hotel",
      costMinor: 9000,
      currencyCode: "USD",
      date: "2026-05-01",
      splitType: "equal",
      participants: [
        { userId: owner, paidMinor: 9000 },
        { userId: ghost, paidMinor: 0 },
      ],
      createdBy: owner,
    });

    const since = (await as(claimerToken, "/sync/pull?since=0")).body.seq;

    await mergeUsers(ghost, claimer);

    const { body } = await as(claimerToken, `/sync/pull?since=${since}`);

    const merge = body.changes.find((ch: any) => ch.entity === "user_merge");
    assert.ok(merge, "the survivor has to learn the ghost is them");
    assert.deepEqual(merge.data, { fromUserId: ghost, toUserId: claimer });

    const expense = body.changes.find(
      (ch: any) => ch.entity === "expense" && ch.data?.id === shared,
    );
    assert.ok(expense, "the rewritten bill travels; the client never adds shares itself");
    assert.equal(
      expense.data.shares.some((s: any) => s.userId === ghost),
      false,
      "the ghost is not on it any more",
    );
    assert.equal(
      expense.data.shares.find((s: any) => s.userId === claimer).owedShareMinor,
      4500,
    );

    // The merge row must be applied before the rows that name the survivor.
    assert.ok(merge.seq < expense.seq);

    // And the survivor's new membership triggers a group catch-up rather than a
    // full re-bootstrap.
    assert.deepEqual(body.catchUp, [{ entity: "group", id: trip }]);
  });
});
