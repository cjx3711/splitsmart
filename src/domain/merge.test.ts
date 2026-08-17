/**
 * Merge: the money must not move.
 *
 * Every test here is a variation on one question. Claiming a placeholder
 * rearranges rows in four tables; if any of those rearrangements changes a
 * number, somebody's balance silently shifts and nothing tells them. So the
 * assertions are mostly "this total is the same as it was", plus the two
 * structural rules the schema cannot express: shares still sum to the cost, and
 * expense_repayments still agrees with expense_users.
 *
 * DATABASE_PATH is set before importing anything that reaches src/db/index.ts,
 * which opens a connection at module load.
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-merge-test-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../db/migrate.ts");
const { seed } = await import("../db/seed.ts");
const { db, sqlite } = await import("../db/index.ts");
const { createExpense } = await import("./expenses.ts");
const { mergeUsers, previewMerge, MergeError } = await import("./merge.ts");
const { addFriendship } = await import("./friends.ts");
const { getBalanceBetween, getGroupBalances } = await import("./balances.ts");
const { ulid } = await import("./ulid.ts");

before(() => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);
});

after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures. Each test builds its own people so nothing leaks between them.
// ---------------------------------------------------------------------------

async function makeAccount(name: string): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({
      id,
      email: `${name.toLowerCase()}-${id}@example.com`,
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      first_name: name,
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();
  return id;
}

async function makeGhost(name: string): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({ id, first_name: name, default_currency: "USD", is_ghost: 1 })
    .execute();
  return id;
}

async function makeGroup(name: string, members: string[]): Promise<string> {
  const id = ulid();
  await db
    .insertInto("groups")
    .values({ id, name, group_type: "trip", default_currency: "USD", created_by: members[0]! })
    .execute();
  for (const [i, userId] of members.entries()) {
    await db
      .insertInto("group_members")
      .values({
        group_id: id,
        user_id: userId,
        role: i === 0 ? "owner" : "member",
        joined_via: i === 0 ? "creator" : "added",
      })
      .execute();
  }
  return id;
}

/**
 * The two things `yarn db:check` verifies, run inline so a failing merge points
 * at the test that broke it rather than at a later audit.
 */
async function assertInvariants(): Promise<void> {
  const badTotals = sqlite
    .prepare(
      `SELECT e.id,
              COALESCE(SUM(eu.paid_share_minor), 0) AS paid,
              COALESCE(SUM(eu.owed_share_minor), 0) AS owed,
              e.cost_minor
       FROM expenses e
       LEFT JOIN expense_users eu ON eu.expense_id = e.id
       WHERE e.deleted_at IS NULL
       GROUP BY e.id
       HAVING paid <> e.cost_minor OR owed <> e.cost_minor`,
    )
    .all();
  assert.deepEqual(badTotals, [], "shares must still sum to the expense total");

  const staleCache = sqlite
    .prepare(
      `WITH net AS (
         SELECT eu.expense_id, eu.user_id,
                eu.paid_share_minor - eu.owed_share_minor AS net_minor
         FROM expense_users eu
         JOIN expenses e ON e.id = eu.expense_id
         WHERE e.deleted_at IS NULL
       ),
       derived AS (
         SELECT expense_id, user_id, SUM(amount) AS amount FROM (
           SELECT expense_id, to_user_id   AS user_id,  amount_minor AS amount
           FROM expense_repayments
           UNION ALL
           SELECT expense_id, from_user_id AS user_id, -amount_minor AS amount
           FROM expense_repayments
         ) GROUP BY expense_id, user_id
       )
       SELECT n.expense_id, n.user_id
       FROM net n
       LEFT JOIN derived d ON d.expense_id = n.expense_id AND d.user_id = n.user_id
       WHERE n.net_minor <> COALESCE(d.amount, 0)`,
    )
    .all();
  assert.deepEqual(staleCache, [], "expense_repayments must still match expense_users");

  const danglingStub = sqlite
    .prepare(
      `WITH stub AS (SELECT id FROM users WHERE merged_into_user_id IS NOT NULL)
       SELECT eu.user_id FROM expense_users eu JOIN stub ON stub.id = eu.user_id
       UNION ALL
       SELECT gm.user_id FROM group_members gm JOIN stub ON stub.id = gm.user_id
       UNION ALL
       SELECT f.user_a_id FROM friendships f JOIN stub ON stub.id = f.user_a_id
       UNION ALL
       SELECT f.user_b_id FROM friendships f JOIN stub ON stub.id = f.user_b_id
       UNION ALL
       SELECT r.from_user_id FROM expense_repayments r JOIN stub ON stub.id = r.from_user_id
       UNION ALL
       SELECT r.to_user_id FROM expense_repayments r JOIN stub ON stub.id = r.to_user_id`,
    )
    .all();
  assert.deepEqual(danglingStub, [], "nothing may still point at a merged stub");
}

function sharesOf(expenseId: string) {
  return db
    .selectFrom("expense_users")
    .select(["user_id", "paid_share_minor", "owed_share_minor", "split_input"])
    .where("expense_id", "=", expenseId)
    .orderBy("user_id")
    .execute();
}

// ---------------------------------------------------------------------------

describe("mergeUsers: expenses only the ghost is on", () => {
  test("transfers the share untouched and leaves the balance where it was", async () => {
    const owner = await makeAccount("Owner");
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");
    const groupId = await makeGroup("Trip", [owner, ghost, account]);

    const expenseId = await createExpense({
      groupId,
      description: "Hotel",
      costMinor: 30_000,
      currencyCode: "USD",
      date: "2026-03-01",
      splitType: "equal",
      participants: [
        { userId: owner, paidMinor: 30_000 },
        { userId: ghost, paidMinor: 0 },
      ],
      createdBy: owner,
    });

    const before = await sharesOf(expenseId);
    const ghostOwed = before.find((s) => s.user_id === ghost)!.owed_share_minor;
    assert.equal(ghostOwed, 15_000);

    await mergeUsers(ghost, account);

    const after = await sharesOf(expenseId);
    assert.equal(after.length, 2);
    assert.equal(after.find((s) => s.user_id === account)!.owed_share_minor, ghostOwed);
    assert.equal(after.find((s) => s.user_id === ghost), undefined);

    const owed = await getBalanceBetween(db, account, owner);
    assert.deepEqual(owed, [{ currencyCode: "USD", amountMinor: -15_000 }]);

    await assertInvariants();
  });
});

describe("mergeUsers: expenses both are on", () => {
  test("combines the two shares instead of re-splitting the bill", async () => {
    const owner = await makeAccount("Owner");
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");
    const groupId = await makeGroup("Dinner club", [owner, ghost, account]);

    // 100.00 three ways: 33.34 / 33.33 / 33.33 (the leftover cent goes to the
    // earliest userId). Re-splitting two ways after the merge would produce
    // 50/50 and move a lot more than a cent.
    const expenseId = await createExpense({
      groupId,
      description: "Dinner",
      costMinor: 10_000,
      currencyCode: "USD",
      date: "2026-03-02",
      splitType: "equal",
      participants: [
        { userId: owner, paidMinor: 10_000 },
        { userId: ghost, paidMinor: 0 },
        { userId: account, paidMinor: 0 },
      ],
      createdBy: owner,
    });

    const before = await sharesOf(expenseId);
    const ghostOwed = before.find((s) => s.user_id === ghost)!.owed_share_minor;
    const accountOwed = before.find((s) => s.user_id === account)!.owed_share_minor;

    await mergeUsers(ghost, account);

    const after = await sharesOf(expenseId);
    assert.equal(after.length, 2, "one fewer slice, same pie");
    assert.equal(
      after.find((s) => s.user_id === account)!.owed_share_minor,
      ghostOwed + accountOwed,
      "shares add, they do not get recomputed",
    );

    // The owner is still owed exactly what they were owed.
    const owed = await getBalanceBetween(db, owner, account);
    assert.deepEqual(owed, [{ currencyCode: "USD", amountMinor: ghostOwed + accountOwed }]);

    await assertInvariants();
  });

  test("an equal split does not reshuffle anyone else's cents", async () => {
    const owner = await makeAccount("Owner");
    const bystander = await makeAccount("Bystander");
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");
    const groupId = await makeGroup("Four", [owner, bystander, ghost, account]);

    // 10.00 four ways is 2.50 each: clean. 10.01 four ways is not.
    const expenseId = await createExpense({
      groupId,
      description: "Awkward total",
      costMinor: 1_001,
      currencyCode: "USD",
      date: "2026-03-03",
      splitType: "equal",
      participants: [
        { userId: owner, paidMinor: 1_001 },
        { userId: bystander, paidMinor: 0 },
        { userId: ghost, paidMinor: 0 },
        { userId: account, paidMinor: 0 },
      ],
      createdBy: owner,
    });

    const before = await sharesOf(expenseId);
    const bystanderBefore = before.find((s) => s.user_id === bystander)!.owed_share_minor;

    await mergeUsers(ghost, account);

    const after = await sharesOf(expenseId);
    assert.equal(
      after.find((s) => s.user_id === bystander)!.owed_share_minor,
      bystanderBefore,
      "a merge between two other people must not move a bystander's cent",
    );

    await assertInvariants();
  });

  test("stores the result as an exact split with owed amounts as the input", async () => {
    const owner = await makeAccount("Owner");
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");
    const groupId = await makeGroup("Percentages", [owner, ghost, account]);

    const expenseId = await createExpense({
      groupId,
      description: "Rent",
      costMinor: 100_000,
      currencyCode: "USD",
      date: "2026-03-04",
      splitType: "percent",
      participants: [
        { userId: owner, paidMinor: 100_000, input: 50 },
        { userId: ghost, paidMinor: 0, input: 20 },
        { userId: account, paidMinor: 0, input: 30 },
      ],
      createdBy: owner,
    });

    await mergeUsers(ghost, account);

    const expense = await db
      .selectFrom("expenses")
      .select(["split_type", "split_meta"])
      .where("id", "=", expenseId)
      .executeTakeFirstOrThrow();

    assert.equal(expense.split_type, "exact");
    assert.equal(expense.split_meta, null);

    const after = await sharesOf(expenseId);
    for (const share of after) {
      assert.equal(
        share.split_input,
        share.owed_share_minor,
        "split_input must restate the amount, not the old percentage",
      );
    }
    assert.equal(after.find((s) => s.user_id === account)!.owed_share_minor, 50_000);

    await assertInvariants();
  });

  test("an itemized expense becomes exact and drops its line items", async () => {
    const owner = await makeAccount("Owner");
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");
    const groupId = await makeGroup("Ramen", [owner, ghost, account]);

    const expenseId = await createExpense({
      groupId,
      description: "Ramen",
      costMinor: 3_000,
      currencyCode: "USD",
      date: "2026-03-05",
      splitType: "itemized",
      participants: [
        { userId: owner, paidMinor: 3_000 },
        { userId: ghost, paidMinor: 0 },
        { userId: account, paidMinor: 0 },
      ],
      items: [
        { label: "Tonkotsu", amountMinor: 1_000, participantIds: [owner] },
        { label: "Shoyu", amountMinor: 1_000, participantIds: [ghost] },
        { label: "Gyoza", amountMinor: 1_000, participantIds: [account] },
      ],
      createdBy: owner,
    });

    await mergeUsers(ghost, account);

    const expense = await db
      .selectFrom("expenses")
      .select(["split_type", "split_meta"])
      .where("id", "=", expenseId)
      .executeTakeFirstOrThrow();

    assert.equal(expense.split_type, "exact");
    assert.equal(
      expense.split_meta,
      null,
      "line items name participants who no longer exist; the editor must not reopen them",
    );

    const after = await sharesOf(expenseId);
    assert.equal(after.find((s) => s.user_id === account)!.owed_share_minor, 2_000);

    await assertInvariants();
  });

  test("a settle-up between the two of them nets to nothing", async () => {
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");
    await addFriendship(db, ghost, account);

    const expenseId = await createExpense({
      description: "Payment",
      costMinor: 2_500,
      currencyCode: "USD",
      date: "2026-03-06",
      splitType: "exact",
      isPayment: true,
      participants: [
        { userId: account, paidMinor: 2_500, input: 0 },
        { userId: ghost, paidMinor: 0, input: 2_500 },
      ],
      createdBy: account,
    });

    await mergeUsers(ghost, account);

    const after = await sharesOf(expenseId);
    assert.equal(after.length, 1);
    assert.equal(after[0]!.paid_share_minor, 2_500);
    assert.equal(after[0]!.owed_share_minor, 2_500);

    const repayments = await db
      .selectFrom("expense_repayments")
      .selectAll()
      .where("expense_id", "=", expenseId)
      .execute();
    assert.deepEqual(repayments, [], "you cannot owe yourself");

    await assertInvariants();
  });
});

describe("mergeUsers: group membership", () => {
  test("moves a membership the account does not already have", async () => {
    const owner = await makeAccount("Owner");
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");
    const groupId = await makeGroup("Ghost only", [owner, ghost]);

    await mergeUsers(ghost, account);

    const members = await db
      .selectFrom("group_members")
      .select(["user_id", "role"])
      .where("group_id", "=", groupId)
      .execute();

    assert.deepEqual(
      members.map((m) => m.user_id).sort(),
      [owner, account].sort(),
    );
    await assertInvariants();
  });

  test("drops the ghost row and keeps owner when either side owned the group", async () => {
    const account = await makeAccount("Alicia");
    const other = await makeAccount("Other");
    const ghost = await makeGhost("Alice");

    // The ghost is the owner; the account is a plain member.
    const groupId = await makeGroup("Ghost owns it", [ghost, other, account]);

    await mergeUsers(ghost, account);

    const rows = await db
      .selectFrom("group_members")
      .select(["user_id", "role"])
      .where("group_id", "=", groupId)
      .execute();

    assert.equal(rows.length, 2);
    assert.equal(rows.find((r) => r.user_id === account)!.role, "owner");
    assert.equal(rows.find((r) => r.user_id === ghost), undefined);
    await assertInvariants();
  });

  test("group balances still net to zero afterwards", async () => {
    const owner = await makeAccount("Owner");
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");
    const groupId = await makeGroup("Balances", [owner, ghost, account]);

    await createExpense({
      groupId,
      description: "Taxi",
      costMinor: 7_777,
      currencyCode: "USD",
      date: "2026-03-07",
      splitType: "equal",
      participants: [
        { userId: owner, paidMinor: 7_777 },
        { userId: ghost, paidMinor: 0 },
        { userId: account, paidMinor: 0 },
      ],
      createdBy: owner,
    });

    await mergeUsers(ghost, account);

    const balances = await getGroupBalances(db, groupId);
    const total = balances
      .flatMap((b) => b.balances)
      .reduce((sum, b) => sum + b.amountMinor, 0);
    assert.equal(total, 0);
    await assertInvariants();
  });
});

describe("mergeUsers: friendships", () => {
  test("rewrites the pair and drops one that would become a self-friendship", async () => {
    const owner = await makeAccount("Owner");
    const third = await makeAccount("Third");
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");

    // The owner added the placeholder, and also knows a third party.
    await addFriendship(db, owner, ghost);
    await addFriendship(db, third, ghost);
    // The account is already friends with the owner: a duplicate after merge.
    await addFriendship(db, owner, account);
    // And is friends with the ghost, which becomes friends-with-yourself.
    await addFriendship(db, account, ghost);

    await mergeUsers(ghost, account);

    const rows = await db.selectFrom("friendships").selectAll().execute();
    const pairs = rows.map((r) => [r.user_a_id, r.user_b_id].sort().join("|")).sort();

    assert.deepEqual(pairs, [
      [owner, account].sort().join("|"),
      [third, account].sort().join("|"),
    ].sort());

    assert.ok(
      !rows.some((r) => r.user_a_id === r.user_b_id),
      "a self-friendship must never be written",
    );
    await assertInvariants();
  });
});

describe("mergeUsers: what happens to the ghost row", () => {
  test("retires it as a stub and revokes every link that could act as it", async () => {
    const owner = await makeAccount("Owner");
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");
    const groupId = await makeGroup("Links", [owner, ghost]);

    await db
      .insertInto("access_links")
      .values({
        id: ulid(),
        token_hash: `hash-${ulid()}`,
        kind: "group_member",
        group_id: groupId,
        user_id: ghost,
        created_by: owner,
      })
      .execute();

    const result = await mergeUsers(ghost, account);
    assert.equal(result.linksRevoked, 1);

    const stub = await db
      .selectFrom("users")
      .select(["merged_into_user_id", "deleted_at", "email"])
      .where("id", "=", ghost)
      .executeTakeFirstOrThrow();

    assert.equal(stub.merged_into_user_id, account);
    assert.ok(stub.deleted_at, "a merged row must be soft-deleted");
    assert.equal(stub.email, null, "the address is freed for the survivor");

    const link = await db
      .selectFrom("access_links")
      .select("revoked_at")
      .where("user_id", "=", ghost)
      .executeTakeFirstOrThrow();
    assert.ok(link.revoked_at);

    await assertInvariants();
  });

  test("refuses to merge a real account, or to run twice", async () => {
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");
    const another = await makeAccount("Another");

    await assert.rejects(() => mergeUsers(another, account), MergeError);
    await assert.rejects(() => mergeUsers(account, account), MergeError);

    await mergeUsers(ghost, account);
    await assert.rejects(() => mergeUsers(ghost, account), MergeError);
  });
});

describe("previewMerge", () => {
  test("separates overlapping expenses from ones only the ghost is on", async () => {
    const owner = await makeAccount("Owner");
    const ghost = await makeGhost("Alice");
    const account = await makeAccount("Alicia");
    const groupId = await makeGroup("Preview", [owner, ghost, account]);

    await createExpense({
      groupId,
      description: "Both of us",
      costMinor: 3_000,
      currencyCode: "USD",
      date: "2026-03-08",
      splitType: "equal",
      participants: [
        { userId: owner, paidMinor: 3_000 },
        { userId: ghost, paidMinor: 0 },
        { userId: account, paidMinor: 0 },
      ],
      createdBy: owner,
    });

    await createExpense({
      groupId,
      description: "Ghost only",
      costMinor: 2_000,
      currencyCode: "USD",
      date: "2026-03-09",
      splitType: "equal",
      participants: [
        { userId: owner, paidMinor: 2_000 },
        { userId: ghost, paidMinor: 0 },
      ],
      createdBy: owner,
    });

    const preview = await previewMerge(db, ghost, account);

    assert.equal(preview.overlapping.length, 1);
    assert.equal(preview.overlapping[0]!.description, "Both of us");
    assert.equal(preview.transferredCount, 1);
    assert.equal(preview.sharedGroupCount, 1);
  });
});
