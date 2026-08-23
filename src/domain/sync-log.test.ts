/**
 * `expenses.version` and the `sync_log`, through the real domain writers.
 *
 * These are the foundations everything else in docs/OFFLINE.md sits on, and the
 * failure modes are quiet ones. A missing log row does not throw; it means a
 * change that no other device will ever learn about. A version that bumps when it
 * should not means somebody's offline typo fix conflicts with a scheduler tick. A
 * version that does not bump when it should means a stale edit silently overwrites
 * a delete. None of those are visible without a test that looks.
 *
 * What is pinned here:
 *
 *   - the bump table from docs/OFFLINE.md, write by write
 *   - `expectedVersion` is a conflict, not an overwrite, and no money moves
 *   - every accepted write leaves exactly the log rows the pull query needs
 *   - a participant losing access gets a `forget` addressed to them; one who is
 *     still in the group does not
 *   - a comment does not touch the expense's version
 *   - a merge fans out `user_merge` BEFORE the expense rows it rewrites
 *
 * DATABASE_PATH is set before importing anything that reaches src/db/index.ts,
 * which opens its connection at module load.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-synclog-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../db/migrate.ts");
const { seed } = await import("../db/seed.ts");
const { db, transaction } = await import("../db/index.ts");
const {
  createExpense,
  updateExpense,
  deleteExpense,
  restoreExpense,
  advanceRepeatSchedule,
  markImportSynced,
  ExpenseConflictError,
} = await import("./expenses.ts");
const { createComment, deleteComment } = await import("./comments.ts");
const { addFriendship, removeFriendship } = await import("./friends.ts");
const { mergeUsers } = await import("./merge.ts");
const { getPairwiseBalances } = await import("./balances.ts");
const { ulid } = await import("./ulid.ts");
const { logChange } = await import("./sync-log.ts");

let aliceId: string;
let bobId: string;
let carolId: string;
let groupId: string;

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

async function ghostUser(name: string): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({ id, name, default_currency: "USD", is_ghost: 1 })
    .execute();
  return id;
}

async function makeGroup(members: string[]): Promise<string> {
  const id = ulid();
  await db
    .insertInto("groups")
    .values({ id, name: `Group ${id.slice(-4)}`, created_by: members[0]! })
    .execute();
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

/** An equal two- or three-way dinner, so the shares are never all zero. */
async function dinner(
  participants: string[],
  overrides: Partial<Parameters<typeof createExpense>[0]> = {},
): Promise<string> {
  return createExpense({
    groupId: groupId,
    description: "Dinner",
    costMinor: 3000,
    currencyCode: "USD",
    date: "2026-03-01",
    splitType: "equal",
    participants: participants.map((userId, i) => ({
      userId,
      paidMinor: i === 0 ? 3000 : 0,
    })),
    createdBy: participants[0]!,
    ...overrides,
  });
}

async function versionOf(expenseId: string): Promise<number> {
  const row = await db
    .selectFrom("expenses")
    .select("version")
    .where("id", "=", expenseId)
    .executeTakeFirstOrThrow();
  return row.version;
}

/** Log rows for one entity id, oldest first. */
async function logFor(entityId: string) {
  return db
    .selectFrom("sync_log")
    .select(["seq", "entity", "entity_id", "op", "group_id", "audience_user_id", "other_user_id"])
    .where("entity_id", "=", entityId)
    .orderBy("seq")
    .execute();
}

/** Everything logged from `seq` onwards, oldest first. Nothing else runs here. */
async function logSince(seq: number) {
  return db
    .selectFrom("sync_log")
    .select(["seq", "entity", "entity_id", "op", "group_id", "audience_user_id", "other_user_id"])
    .where("seq", ">", seq)
    .orderBy("seq")
    .execute();
}

async function head(): Promise<number> {
  const row = await db
    .selectFrom("sync_log")
    .select((eb) => eb.fn.max<number | null>("seq").as("seq"))
    .executeTakeFirst();
  return row?.seq ?? 0;
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  aliceId = await realUser("Alice", "alice@example.com");
  bobId = await realUser("Bob", "bob@example.com");
  carolId = await realUser("Carol", "carol@example.com");
  groupId = await makeGroup([aliceId, bobId, carolId]);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("version", () => {
  test("a new expense starts at 1", async () => {
    const id = await dinner([aliceId, bobId]);
    assert.equal(await versionOf(id), 1);
  });

  test("an edit bumps it, and reports the version it wrote", async () => {
    const id = await dinner([aliceId, bobId]);

    const result = await updateExpense(id, {
      groupId,
      description: "Dinner, but cheaper",
      costMinor: 2000,
      currencyCode: "USD",
      date: "2026-03-01",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 2000 },
        { userId: bobId, paidMinor: 0 },
      ],
      updatedBy: aliceId,
    });

    assert.equal(result.version, 2);
    assert.equal(await versionOf(id), 2);
  });

  test("delete and restore each bump, so a tombstone is not the row it replaced", async () => {
    const id = await dinner([aliceId, bobId]);

    const deleted = await deleteExpense(id, aliceId);
    assert.deepEqual(deleted, { version: 2, noop: false });

    const restored = await restoreExpense(id, bobId);
    assert.deepEqual(restored, { version: 3, noop: false });
  });

  test("deleting or restoring twice is a no-op that consumes no version", async () => {
    const id = await dinner([aliceId, bobId]);

    await deleteExpense(id, aliceId);
    assert.deepEqual(await deleteExpense(id, aliceId), { version: 2, noop: true });

    await restoreExpense(id, aliceId);
    assert.deepEqual(await restoreExpense(id, aliceId), { version: 3, noop: true });
  });

  test("a scheduler tick does NOT bump: rent must not conflict with a typo fix", async () => {
    const id = await createExpense({
      groupId,
      description: "Rent",
      costMinor: 120000,
      currencyCode: "USD",
      date: "2026-03-01",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 120000 },
        { userId: bobId, paidMinor: 0 },
      ],
      repeatInterval: "monthly",
      createdBy: aliceId,
    });

    const before = await versionOf(id);
    const template = await db
      .selectFrom("expenses")
      .select("next_repeat")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    assert.equal(await advanceRepeatSchedule(id, template.next_repeat!, "monthly"), true);
    assert.equal(await versionOf(id), before);
  });

  test("the importer's re-sync stamp does NOT bump, and logs nothing", async () => {
    const id = await dinner([aliceId, bobId]);
    const before = await versionOf(id);
    const mark = await head();

    await markImportSynced(id, { splitwise_id: 4242 });

    assert.equal(await versionOf(id), before);
    assert.deepEqual(await logSince(mark), []);
  });

  test("a comment does not touch the expense's version", async () => {
    const id = await dinner([aliceId, bobId]);
    const before = await versionOf(id);

    const commentId = await createComment({
      expenseId: id,
      userId: aliceId,
      content: "Was this the ramen place?",
    });
    assert.equal(await versionOf(id), before);

    await deleteComment(commentId, aliceId);
    assert.equal(await versionOf(id), before);
  });
});

describe("expectedVersion", () => {
  test("a matching version applies", async () => {
    const id = await dinner([aliceId, bobId]);

    const result = await updateExpense(id, {
      groupId,
      description: "Dinner",
      costMinor: 2400,
      currencyCode: "USD",
      date: "2026-03-01",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 2400 },
        { userId: bobId, paidMinor: 0 },
      ],
      updatedBy: aliceId,
      expectedVersion: 1,
    });

    assert.equal(result.version, 2);
  });

  test("a stale version is a conflict, and moves no money", async () => {
    const id = await dinner([aliceId, bobId]);

    // Somebody else edits first. Our client still believes it is at version 1.
    await updateExpense(id, {
      groupId,
      description: "Dinner",
      costMinor: 5000,
      currencyCode: "USD",
      date: "2026-03-01",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 5000 },
        { userId: bobId, paidMinor: 0 },
      ],
      updatedBy: bobId,
    });

    const balancesBefore = await getPairwiseBalances(db, aliceId);

    await assert.rejects(
      () =>
        updateExpense(id, {
          groupId,
          description: "Dinner",
          costMinor: 1000,
          currencyCode: "USD",
          date: "2026-03-01",
          splitType: "equal",
          participants: [
            { userId: aliceId, paidMinor: 1000 },
            { userId: bobId, paidMinor: 0 },
          ],
          updatedBy: aliceId,
          expectedVersion: 1,
        }),
      (err: unknown) => {
        assert.ok(err instanceof ExpenseConflictError);
        assert.equal(err.expectedVersion, 1);
        assert.equal(err.currentVersion, 2);
        return true;
      },
    );

    const row = await db
      .selectFrom("expenses")
      .select(["cost_minor", "version"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();

    assert.equal(row.cost_minor, 5000, "the loser's amount must not have landed");
    assert.equal(row.version, 2, "a refused write consumes no version");
    assert.deepEqual(await getPairwiseBalances(db, aliceId), balancesBefore);
  });

  test("delete-wins: an edit at the tombstone's old version conflicts", async () => {
    const id = await dinner([aliceId, bobId]);
    await deleteExpense(id, bobId); // version 1 -> 2

    await assert.rejects(
      () =>
        updateExpense(id, {
          groupId,
          description: "Dinner",
          costMinor: 100,
          currencyCode: "USD",
          date: "2026-03-01",
          splitType: "equal",
          participants: [
            { userId: aliceId, paidMinor: 100 },
            { userId: bobId, paidMinor: 0 },
          ],
          updatedBy: aliceId,
          expectedVersion: 1,
        }),
      /is deleted/,
    );

    const row = await db
      .selectFrom("expenses")
      .select(["deleted_at", "cost_minor"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    assert.notEqual(row.deleted_at, null, "the edit must not have resurrected it");
    assert.equal(row.cost_minor, 3000);
  });

  test("restoring a tombstone at a stale version conflicts", async () => {
    const id = await dinner([aliceId, bobId]);
    await deleteExpense(id, aliceId); // -> 2

    await assert.rejects(
      () => restoreExpense(id, bobId, { expectedVersion: 1 }),
      (err: unknown) => err instanceof ExpenseConflictError,
    );

    const row = await db
      .selectFrom("expenses")
      .select("deleted_at")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    assert.notEqual(row.deleted_at, null);
  });
});

describe("sync_log rows", () => {
  test("a create logs one expense upsert carrying its group", async () => {
    const mark = await head();
    const id = await dinner([aliceId, bobId]);

    const rows = await logSince(mark);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.entity, "expense");
    assert.equal(rows[0]!.entity_id, id);
    assert.equal(rows[0]!.op, "upsert");
    assert.equal(rows[0]!.group_id, groupId);
    assert.equal(rows[0]!.audience_user_id, null);
  });

  test("an import create logs too, even with the feed entry suppressed", async () => {
    const mark = await head();
    const id = await dinner([aliceId, bobId], { recordActivity: false });

    // The log is a replication log, not an activity feed. `recordActivity: false`
    // means "do not narrate this"; every device still needs the row.
    const rows = await logSince(mark);
    assert.deepEqual(
      rows.map((r) => [r.entity, r.entity_id, r.op]),
      [["expense", id, "upsert"]],
    );
  });

  test("a delete logs `delete`, not `forget`: everyone keeps the tombstone", async () => {
    const id = await dinner([aliceId, bobId]);
    const mark = await head();

    await deleteExpense(id, aliceId);

    const rows = (await logSince(mark)).filter((r) => r.entity === "expense");
    assert.deepEqual(
      rows.map((r) => r.op),
      ["delete"],
    );
  });

  test("a restore logs an upsert: the row is simply live again", async () => {
    const id = await dinner([aliceId, bobId]);
    await deleteExpense(id, aliceId);
    const mark = await head();

    await restoreExpense(id, bobId);

    const rows = (await logSince(mark)).filter((r) => r.entity === "expense");
    assert.deepEqual(
      rows.map((r) => r.op),
      ["upsert"],
    );
  });

  test("a scheduler tick still logs, so other devices see the series move", async () => {
    const id = await createExpense({
      groupId,
      description: "Gym",
      costMinor: 5000,
      currencyCode: "USD",
      date: "2026-03-01",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 5000 },
        { userId: bobId, paidMinor: 0 },
      ],
      repeatInterval: "monthly",
      createdBy: aliceId,
    });
    const template = await db
      .selectFrom("expenses")
      .select("next_repeat")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const mark = await head();

    await advanceRepeatSchedule(id, template.next_repeat!, "monthly");

    const rows = await logSince(mark);
    assert.deepEqual(
      rows.map((r) => [r.entity, r.entity_id, r.op]),
      [["expense", id, "upsert"]],
    );
  });

  test("a tick that loses the race logs nothing", async () => {
    const id = await dinner([aliceId, bobId]);
    const mark = await head();

    // Not a template at all, so the guarded UPDATE matches no row.
    assert.equal(await advanceRepeatSchedule(id, "2026-04-01T00:00:00Z", "monthly"), false);
    assert.deepEqual(await logSince(mark), []);
  });

  test("comments log with their parent's group, both create and delete", async () => {
    const id = await dinner([aliceId, bobId]);
    const mark = await head();

    const commentId = await createComment({
      expenseId: id,
      userId: bobId,
      content: "I'll get the next one",
    });
    await deleteComment(commentId, bobId);

    const rows = (await logSince(mark)).filter((r) => r.entity === "comment");
    assert.deepEqual(
      rows.map((r) => [r.entity_id, r.op, r.group_id]),
      [
        [commentId, "upsert", groupId],
        [commentId, "delete", groupId],
      ],
    );
  });

  test("a system comment is logged, because other devices have to receive it", async () => {
    const id = await dinner([aliceId, bobId]);
    const mark = await head();

    await updateExpense(id, {
      groupId,
      description: "Dinner and drinks",
      costMinor: 3000,
      currencyCode: "USD",
      date: "2026-03-01",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 3000 },
        { userId: bobId, paidMinor: 0 },
      ],
      updatedBy: aliceId,
    });

    const rows = await logSince(mark);
    const comments = rows.filter((r) => r.entity === "comment");
    assert.equal(comments.length, 1, "the generated sentence is a row like any other");
    assert.equal(comments[0]!.op, "upsert");
  });

  test("an edit that changes nothing visible logs the expense but no comment", async () => {
    const id = await dinner([aliceId, bobId]);
    const same = {
      groupId,
      description: "Dinner",
      costMinor: 3000,
      currencyCode: "USD",
      date: "2026-03-01",
      splitType: "equal" as const,
      participants: [
        { userId: aliceId, paidMinor: 3000 },
        { userId: bobId, paidMinor: 0 },
      ],
      updatedBy: aliceId,
    };
    const mark = await head();

    await updateExpense(id, same);

    const rows = await logSince(mark);
    assert.equal(rows.filter((r) => r.entity === "comment").length, 0);
    assert.equal(rows.filter((r) => r.entity === "expense" && r.op === "upsert").length, 1);
  });

  test("friendships log as a canonical pair, and removal is `delete` not `forget`", async () => {
    const mark = await head();

    await addFriendship(bobId, aliceId);
    await addFriendship(bobId, aliceId); // idempotent: must not log twice
    await removeFriendship(aliceId, bobId);

    const [low, high] = aliceId < bobId ? [aliceId, bobId] : [bobId, aliceId];
    const rows = (await logSince(mark)).filter((r) => r.entity === "friendship");
    assert.deepEqual(
      rows.map((r) => [r.entity_id, r.other_user_id, r.op]),
      [
        [low, high, "upsert"],
        [low, high, "delete"],
      ],
    );
  });
});

describe("audience changes on an edit", () => {
  test("a dropped participant who is still a group member gets no forget", async () => {
    const id = await dinner([aliceId, bobId, carolId]);
    const mark = await head();

    await updateExpense(id, {
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
      updatedBy: aliceId,
    });

    // Carol is off the bill but still in the group, so she can still see it.
    // A forget here would delete a row she is entitled to.
    const forgets = (await logSince(mark)).filter((r) => r.op === "forget");
    assert.deepEqual(forgets, []);
  });

  test("a dropped participant on a non-group bill gets a forget addressed to them", async () => {
    const id = await createExpense({
      groupId: null,
      description: "Taxi",
      costMinor: 3000,
      currencyCode: "USD",
      date: "2026-03-02",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 3000 },
        { userId: bobId, paidMinor: 0 },
        { userId: carolId, paidMinor: 0 },
      ],
      createdBy: aliceId,
    });
    const mark = await head();

    await updateExpense(id, {
      groupId: null,
      description: "Taxi",
      costMinor: 3000,
      currencyCode: "USD",
      date: "2026-03-02",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 3000 },
        { userId: bobId, paidMinor: 0 },
      ],
      updatedBy: aliceId,
    });

    const forgets = (await logSince(mark)).filter((r) => r.op === "forget");
    assert.deepEqual(
      forgets.map((r) => [r.entity, r.entity_id, r.audience_user_id]),
      [["expense", id, carolId]],
    );
  });

  test("someone newly added to a non-group bill gets a catch-up marker", async () => {
    const id = await createExpense({
      groupId: null,
      description: "Cinema",
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
    const mark = await head();

    await updateExpense(id, {
      groupId: null,
      description: "Cinema",
      costMinor: 3000,
      currencyCode: "USD",
      date: "2026-03-03",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 3000 },
        { userId: bobId, paidMinor: 0 },
        { userId: carolId, paidMinor: 0 },
      ],
      updatedBy: aliceId,
    });

    // The expense itself reaches Carol through the participant clause. This extra
    // row is what makes the pull page tell her to fetch the thread, which is all
    // below her cursor.
    const addressed = (await logSince(mark)).filter(
      (r) => r.entity === "expense" && r.audience_user_id === carolId,
    );
    assert.deepEqual(
      addressed.map((r) => r.op),
      ["upsert"],
    );
  });

  test("a group expense gaining a participant needs no marker: comments follow membership", async () => {
    const id = await dinner([aliceId, bobId]);
    const mark = await head();

    await updateExpense(id, {
      groupId,
      description: "Dinner",
      costMinor: 3000,
      currencyCode: "USD",
      date: "2026-03-01",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 3000 },
        { userId: bobId, paidMinor: 0 },
        { userId: carolId, paidMinor: 0 },
      ],
      updatedBy: aliceId,
    });

    const addressed = (await logSince(mark)).filter((r) => r.audience_user_id !== null);
    assert.deepEqual(addressed, []);
  });

  test("moving a bill out of a group forgets it for the members left behind", async () => {
    const id = await dinner([aliceId, bobId]);
    const mark = await head();

    await updateExpense(id, {
      groupId: null,
      description: "Dinner",
      costMinor: 3000,
      currencyCode: "USD",
      date: "2026-03-01",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 3000 },
        { userId: bobId, paidMinor: 0 },
      ],
      updatedBy: aliceId,
    });

    // Carol was never on the bill; she was seeing it through the group, and the
    // new log row does not name her group any more.
    const forgets = (await logSince(mark)).filter((r) => r.op === "forget");
    assert.deepEqual(
      forgets.map((r) => r.audience_user_id),
      [carolId],
    );
  });
});

describe("claim / merge", () => {
  test("fans out user_merge before the expense rows it rewrites", async () => {
    const owner = await realUser("Owner", "owner@example.com");
    const claimer = await realUser("Claimer", "claimer@example.com");
    const bystander = await realUser("Bystander", "bystander@example.com");
    const ghost = await ghostUser("Placeholder");

    const sharedGroup = await makeGroup([owner, ghost, bystander]);
    const shared = await createExpense({
      groupId: sharedGroup,
      description: "Hotel",
      costMinor: 9000,
      currencyCode: "USD",
      date: "2026-03-04",
      splitType: "equal",
      participants: [
        { userId: owner, paidMinor: 9000 },
        { userId: ghost, paidMinor: 0 },
        { userId: bystander, paidMinor: 0 },
      ],
      createdBy: owner,
    });

    const mark = await head();
    await mergeUsers(ghost, claimer);
    const rows = await logSince(mark);

    const merges = rows.filter((r) => r.entity === "user_merge");
    assert.ok(merges.length >= 3, "owner, bystander and the claimer all have to be told");
    for (const row of merges) {
      assert.equal(row.op, "merge");
      assert.equal(row.entity_id, ghost, "entity_id is the ghost being consumed");
      assert.equal(row.other_user_id, claimer, "other_user_id is the survivor");
    }
    assert.deepEqual(
      [...new Set(merges.map((r) => r.audience_user_id))].sort(),
      [owner, claimer, bystander].sort(),
    );

    const expenseUpsert = rows.find((r) => r.entity === "expense" && r.entity_id === shared);
    assert.ok(expenseUpsert, "the rewritten bill has to go out");
    assert.ok(
      Math.max(...merges.map((r) => r.seq)) < expenseUpsert.seq,
      "the remap must be applied before the rows that name the survivor",
    );
  });

  test("a rewritten bill bumps its version, because the shares really changed", async () => {
    const owner = await realUser("Owner2", "owner2@example.com");
    const claimer = await realUser("Claimer2", "claimer2@example.com");
    const ghost = await ghostUser("Placeholder2");

    const sharedGroup = await makeGroup([owner, ghost, claimer]);
    const shared = await createExpense({
      groupId: sharedGroup,
      description: "Ferry",
      costMinor: 3000,
      currencyCode: "USD",
      date: "2026-03-05",
      splitType: "equal",
      participants: [
        { userId: owner, paidMinor: 3000 },
        { userId: ghost, paidMinor: 0 },
        { userId: claimer, paidMinor: 0 },
      ],
      createdBy: owner,
    });
    assert.equal(await versionOf(shared), 1);

    await mergeUsers(ghost, claimer);

    assert.equal(await versionOf(shared), 2);

    // Combined, never re-split: 1000 + 1000, so the third party's cent stays put.
    const shares = await db
      .selectFrom("expense_users")
      .select(["user_id", "owed_share_minor"])
      .where("expense_id", "=", shared)
      .execute();
    assert.equal(shares.length, 2);
    assert.equal(shares.find((s) => s.user_id === claimer)!.owed_share_minor, 2000);
    assert.equal(shares.find((s) => s.user_id === owner)!.owed_share_minor, 1000);
  });

  test("a membership the survivor newly gained is logged, so their other devices catch up", async () => {
    const owner = await realUser("Owner3", "owner3@example.com");
    const claimer = await realUser("Claimer3", "claimer3@example.com");
    const ghost = await ghostUser("Placeholder3");
    const ghostGroup = await makeGroup([owner, ghost]);

    const mark = await head();
    await mergeUsers(ghost, claimer);

    const memberships = (await logSince(mark)).filter((r) => r.entity === "group_member");
    assert.deepEqual(
      memberships.map((r) => [r.entity_id, r.group_id, r.op]),
      [[claimer, ghostGroup, "upsert"]],
    );
  });
});

describe("the log itself", () => {
  test("seq is monotonic and gapless enough to be a cursor", async () => {
    const mark = await head();
    await dinner([aliceId, bobId]);
    await dinner([aliceId, carolId]);

    const rows = await logSince(mark);
    assert.ok(rows.length >= 2);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i]!.seq > rows[i - 1]!.seq, "seq must strictly increase");
    }
  });

  test("a rolled-back write leaves no log row", async () => {
    const mark = await head();

    // A stranger to the group: assertParticipantsAreMembers throws inside the
    // transaction, so the expense and its log row go together.
    const outsider = await realUser("Outsider", "outsider@example.com");
    await assert.rejects(() => dinner([aliceId, outsider]), /not members of group/);

    assert.deepEqual(await logSince(mark), []);
  });

  test("every logged entity id looks like a ULID", async () => {
    const rows = await db.selectFrom("sync_log").select(["entity_id"]).execute();
    assert.ok(rows.length > 0);
    for (const row of rows) assert.equal(row.entity_id.length, 26);
  });

  test("logFor finds a row by its entity id", async () => {
    const id = await dinner([aliceId, bobId]);
    const rows = await logFor(id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.entity_id, id);
  });

  /*
   * SQLite refuses a statement with more than 32766 bind variables. A sync_log
   * row costs seven of them, so a single-statement insert dies at 4681 entries
   * with "too many SQL variables".
   *
   * Ordinary writes log one or two rows and would never have found this. The
   * caller that did was `wipeUserLedger`, which logs a `forget` per expense: on
   * a real imported account (7501 bills) the wipe failed with a 500 every time,
   * which is exactly the operation you reach for when an import went wrong.
   */
  test("a bulk log of more than 4680 entries is chunked, not refused", async () => {
    const entries = Array.from({ length: 5_000 }, () => ({
      entity: "expense" as const,
      entityId: ulid(),
      op: "forget" as const,
      actorUserId: aliceId,
      audienceUserId: aliceId,
    }));

    const before = await db
      .selectFrom("sync_log")
      .select(({ fn }) => fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();

    await transaction((trx) => logChange(trx, ...entries));

    const after = await db
      .selectFrom("sync_log")
      .select(({ fn }) => fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    assert.equal(
      after.n - before.n,
      entries.length,
      "every entry must land: a partial write is a change no device learns about",
    );
  });
});
