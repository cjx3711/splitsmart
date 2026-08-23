/**
 * Friend pairwise after simplify-debts.
 *
 * The cycle that made an imported Splitwise friend look unsettled is the one
 * this pins: three people, three bills, every net zero, raw pairwise not.
 * Turning the group flag on must collapse the friend total; turning it off
 * must bring the raw edges back.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-balances-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../db/migrate.ts");
const { seed } = await import("../db/seed.ts");
const { db } = await import("../db/index.ts");
const { createExpense } = await import("./expenses.ts");
const { getBalanceBetween, getPairwiseBalancesByGroup } = await import("./balances.ts");
const { ulid } = await import("./ulid.ts");

let alice: string;
let bob: string;
let carol: string;
let groupId: string;

async function person(name: string): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({
      id,
      name,
      default_currency: "USD",
      is_ghost: 1,
    })
    .execute();
  return id;
}

async function bill(payer: string, debtor: string) {
  await createExpense({
    groupId,
    description: "Cycle",
    costMinor: 1000,
    currencyCode: "USD",
    date: "2026-08-01",
    splitType: "exact",
    participants: [
      { userId: payer, paidMinor: 1000, input: 0 },
      { userId: debtor, paidMinor: 0, input: 1000 },
    ],
    createdBy: alice,
    recordActivity: false,
  });
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  alice = await person("Alice");
  bob = await person("Bob");
  carol = await person("Carol");

  groupId = ulid();
  await db
    .insertInto("groups")
    .values({
      id: groupId,
      name: "Trip",
      group_type: "trip",
      default_currency: "USD",
      simplify_by_default: 1,
      created_by: alice,
    })
    .execute();
  for (const userId of [alice, bob, carol]) {
    await db
      .insertInto("group_members")
      .values({ group_id: groupId, user_id: userId, role: userId === alice ? "owner" : "member" })
      .execute();
  }

  await bill(alice, bob);
  await bill(bob, carol);
  await bill(carol, alice);
});

after(() => rmSync(tempDir, { recursive: true, force: true }));

describe("simplified friend balances", () => {
  test("a cycle in a simplify-on group is settled between every pair", async () => {
    assert.deepEqual(await getBalanceBetween(db, alice, bob), []);
    assert.deepEqual(await getBalanceBetween(db, alice, carol), []);
    assert.equal((await getPairwiseBalancesByGroup(db, alice)).length, 0);
  });

  test("turning simplify off restores the raw edges", async () => {
    await db
      .updateTable("groups")
      .set({ simplify_by_default: 0 })
      .where("id", "=", groupId)
      .execute();

    const withBob = await getBalanceBetween(db, alice, bob);
    const withCarol = await getBalanceBetween(db, alice, carol);
    assert.equal(withBob.find((b) => b.currencyCode === "USD")?.amountMinor, 1000);
    assert.equal(withCarol.find((b) => b.currencyCode === "USD")?.amountMinor, -1000);

    await db
      .updateTable("groups")
      .set({ simplify_by_default: 1 })
      .where("id", "=", groupId)
      .execute();
  });
});

describe("one-on-one expenses", () => {
  test("a cycle among separate 1-1 bills is left as raw pairwise", async () => {
    const diner = ulid();
    await db
      .insertInto("users")
      .values({
        id: diner,
        name: "Diner",
        default_currency: "USD",
        is_ghost: 1,
      })
      .execute();
    const friendA = ulid();
    const friendB = ulid();
    for (const [id, name] of [
      [friendA, "A"],
      [friendB, "B"],
    ] as const) {
      await db
        .insertInto("users")
        .values({ id, name, default_currency: "USD", is_ghost: 1 })
        .execute();
    }

    async function oneOnOne(payer: string, debtor: string) {
      await createExpense({
        description: "Tab",
        costMinor: 500,
        currencyCode: "USD",
        date: "2026-08-02",
        splitType: "exact",
        participants: [
          { userId: payer, paidMinor: 500, input: 0 },
          { userId: debtor, paidMinor: 0, input: 500 },
        ],
        createdBy: diner,
        recordActivity: false,
      });
    }

    await oneOnOne(diner, friendA);
    await oneOnOne(friendA, friendB);
    await oneOnOne(friendB, diner);

    const raw = await getBalanceBetween(db, diner, friendA);
    assert.equal(raw.find((b) => b.currencyCode === "USD")?.amountMinor, 500);
  });
});
