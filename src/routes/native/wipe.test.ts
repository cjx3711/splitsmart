/**
 * Wiping an account's ledger so a Splitwise import can start over.
 *
 * The properties that matter:
 *
 *   - the account itself survives (email, password, sessions)
 *   - expenses, groups, friendships and placeholder people are gone
 *   - a second real account that shares a group or expense blocks the wipe
 *   - the confirmation phrase is required on the wire
 *
 * DATABASE_PATH is set before importing anything that opens the database.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-wipe-test-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense } = await import("../../domain/expenses.ts");
const { addFriendship } = await import("../../domain/friends.ts");
const { ulid } = await import("../../domain/ulid.ts");
const { WIPE_CONFIRMATION } = await import("../../domain/wipe.ts");
const { serializeMetadata } = await import("../../domain/metadata.ts");

let aliceId: string;
let carolId: string;
let groupId: string;
let apiToken: string;

async function post(path: string, body: unknown, token = apiToken) {
  const res = await app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string, token = apiToken) {
  const res = await app.request(`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  aliceId = ulid();
  await db
    .insertInto("users")
    .values({
      id: aliceId,
      email: "alice@example.com",
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      name: "Alice Anderson",
      default_currency: "USD",
      is_ghost: 0,
      metadata: serializeMetadata({ splitwise_id: 1000 }),
    })
    .execute();

  carolId = ulid();
  await db
    .insertInto("users")
    .values({
      id: carolId,
      name: "Carol Clark",
      default_currency: "USD",
      is_ghost: 1,
      invite_email: "carol@example.com",
      metadata: serializeMetadata({ splitwise_id: 2002 }),
    })
    .execute();

  groupId = ulid();
  await db
    .insertInto("groups")
    .values({
      id: groupId,
      name: "Flat",
      group_type: "home",
      default_currency: "USD",
      created_by: aliceId,
      metadata: serializeMetadata({ splitwise_id: 3001 }),
    })
    .execute();

  await db
    .insertInto("group_members")
    .values([
      { group_id: groupId, user_id: aliceId, role: "owner", joined_via: "import" },
      { group_id: groupId, user_id: carolId, role: "member", joined_via: "import" },
    ])
    .execute();

  await addFriendship(aliceId, carolId, aliceId);

  await createExpense({
    groupId,
    description: "Rent",
    costMinor: 100_000,
    currencyCode: "USD",
    date: "2026-03-01",
    splitType: "equal",
    createdBy: aliceId,
    metadata: { splitwise_id: 4001 },
    participants: [
      { userId: aliceId, paidMinor: 100_000 },
      { userId: carolId, paidMinor: 0 },
    ],
  });

  apiToken = (await createApiToken(aliceId, "test")).token;
});

after(async () => {
  await db.destroy();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("POST /api/v1/import/wipe", () => {
  test("rejects the wrong confirmation phrase", async () => {
    const { status, body } = await post("/import/wipe", { confirm: "please" });
    assert.equal(status, 400);
    assert.equal(body.ok, undefined);
  });

  test("refuses when another real account shares the data", async () => {
    const bobId = ulid();
    await db
      .insertInto("users")
      .values({
        id: bobId,
        email: "bob@example.com",
        password_hash: "scrypt$131072$8$1$AAAA$AAAA",
        name: "Bob Brown",
        default_currency: "USD",
        is_ghost: 0,
      })
      .execute();
    await db
      .insertInto("group_members")
      .values({ group_id: groupId, user_id: bobId, role: "member", joined_via: "added" })
      .execute();

    const { status, body } = await post("/import/wipe", { confirm: WIPE_CONFIRMATION });
    assert.equal(status, 409);
    assert.match(String(body.error), /Bob Brown/);

    await db.deleteFrom("group_members").where("user_id", "=", bobId).execute();
    await db.deleteFrom("users").where("id", "=", bobId).execute();

    const still = await db.selectFrom("expenses").select("id").execute();
    assert.equal(still.length, 1, "a refused wipe must not delete anything");
  });

  test("deletes the ledger and keeps the account", async () => {
    const { status, body } = await post("/import/wipe", { confirm: WIPE_CONFIRMATION });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    const deleted = body.deleted as { expenses: number; groups: number; ghosts: number };
    assert.equal(deleted.expenses, 1);
    assert.equal(deleted.groups, 1);
    assert.equal(deleted.ghosts, 1);

    const me = await get("/auth/me");
    assert.equal(me.status, 200);
    assert.equal((me.body.user as { email: string }).email, "alice@example.com");

    const footprint = await get("/import/status");
    assert.equal(footprint.status, 200);
    assert.equal(footprint.body.hasData, false);
    assert.equal((footprint.body.local as { expenses: number }).expenses, 0);
    assert.equal((footprint.body.local as { groups: number }).groups, 0);

    const expenses = await db.selectFrom("expenses").select("id").execute();
    const groups = await db.selectFrom("groups").select("id").execute();
    const carol = await db.selectFrom("users").select("id").where("id", "=", carolId).execute();
    const friendships = await db.selectFrom("friendships").selectAll().execute();
    assert.deepEqual(expenses, []);
    assert.deepEqual(groups, []);
    assert.deepEqual(carol, []);
    assert.deepEqual(friendships, []);

    const alice = await db
      .selectFrom("users")
      .select(["email", "metadata"])
      .where("id", "=", aliceId)
      .executeTakeFirstOrThrow();
    assert.equal(alice.email, "alice@example.com");
    assert.equal(JSON.parse(alice.metadata).splitwise_id, 1000);
  });

  test("a second wipe on an empty account is a no-op", async () => {
    const { status, body } = await post("/import/wipe", { confirm: WIPE_CONFIRMATION });
    assert.equal(status, 200);
    assert.equal((body.deleted as { expenses: number }).expenses, 0);
  });
});
