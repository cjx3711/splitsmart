/**
 * Closing an account: convert to a ghost when others still share the ledger,
 * otherwise wipe and retire the login.
 *
 * DATABASE_PATH is set before importing anything that opens the database.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-delete-account-"));
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
const { DELETE_ACCOUNT_CONFIRMATION } = await import("../../domain/delete-account.ts");

async function post(path: string, body: unknown, token: string) {
  const res = await app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function person(name: string, email: string): Promise<{ id: string; token: string }> {
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
  const token = (await createApiToken(id, "test")).token;
  return { id, token };
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);
});

after(async () => {
  await db.destroy();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("POST /api/v1/auth/delete", () => {
  test("rejects the wrong confirmation phrase", async () => {
    const alice = await person("Alice", "alice-phrase@example.com");
    const { status } = await post("/auth/delete", { confirm: "please" }, alice.token);
    assert.equal(status, 400);
  });

  test("converts to a ghost when another real account shares a group", async () => {
    const alice = await person("Alice Shared", "alice-share@example.com");
    const bob = await person("Bob Shared", "bob-share@example.com");

    const groupId = ulid();
    await db
      .insertInto("groups")
      .values({
        id: groupId,
        name: "Trip",
        group_type: "trip",
        default_currency: "USD",
        created_by: alice.id,
      })
      .execute();
    await db
      .insertInto("group_members")
      .values([
        { group_id: groupId, user_id: alice.id, role: "owner", joined_via: "creator" },
        { group_id: groupId, user_id: bob.id, role: "member", joined_via: "added" },
      ])
      .execute();

    const expenseId = await createExpense({
      groupId,
      description: "Taxi",
      costMinor: 2000,
      currencyCode: "USD",
      date: "2026-04-01",
      splitType: "equal",
      createdBy: alice.id,
      participants: [
        { userId: alice.id, paidMinor: 2000 },
        { userId: bob.id, paidMinor: 0 },
      ],
    });

    const { status, body } = await post(
      "/auth/delete",
      { confirm: DELETE_ACCOUNT_CONFIRMATION },
      alice.token,
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.convertedToGhost, true);

    const row = await db
      .selectFrom("users")
      .select(["is_ghost", "email", "password_hash", "invite_email", "deleted_at", "name"])
      .where("id", "=", alice.id)
      .executeTakeFirstOrThrow();
    assert.equal(row.is_ghost, 1);
    assert.equal(row.email, null);
    assert.equal(row.password_hash, null);
    assert.equal(row.invite_email, "alice-share@example.com");
    assert.equal(row.deleted_at, null);
    assert.equal(row.name, "Alice Shared");

    const still = await db.selectFrom("expenses").select("id").where("id", "=", expenseId).execute();
    assert.equal(still.length, 1, "shared history must stay for the other account");

    const replay = await app.request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${alice.token}` },
    });
    assert.equal(replay.status, 401, "the token used to delete must die");

    const bobSees = await app.request(`/api/v1/groups/${groupId}`, {
      headers: { Authorization: `Bearer ${bob.token}` },
    });
    assert.equal(bobSees.status, 200);
  });

  test("wipes and retires the account when nobody else shares it", async () => {
    const solo = await person("Solo User", "solo@example.com");
    const ghostId = ulid();
    await db
      .insertInto("users")
      .values({
        id: ghostId,
        name: "Placeholder Pal",
        default_currency: "USD",
        is_ghost: 1,
      })
      .execute();
    await addFriendship(solo.id, ghostId, solo.id);

    const groupId = ulid();
    await db
      .insertInto("groups")
      .values({
        id: groupId,
        name: "Just me",
        group_type: "other",
        default_currency: "USD",
        created_by: solo.id,
      })
      .execute();
    await db
      .insertInto("group_members")
      .values([
        { group_id: groupId, user_id: solo.id, role: "owner", joined_via: "creator" },
        { group_id: groupId, user_id: ghostId, role: "member", joined_via: "added" },
      ])
      .execute();

    await createExpense({
      groupId,
      description: "Milk",
      costMinor: 300,
      currencyCode: "USD",
      date: "2026-05-01",
      splitType: "equal",
      createdBy: solo.id,
      participants: [
        { userId: solo.id, paidMinor: 300 },
        { userId: ghostId, paidMinor: 0 },
      ],
    });

    const { status, body } = await post(
      "/auth/delete",
      { confirm: DELETE_ACCOUNT_CONFIRMATION },
      solo.token,
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.convertedToGhost, false);

    const leftover = await db
      .selectFrom("expense_users")
      .select("expense_id")
      .where("user_id", "=", solo.id)
      .execute();
    const groups = await db.selectFrom("groups").select("id").where("id", "=", groupId).execute();
    const ghost = await db.selectFrom("users").select("id").where("id", "=", ghostId).execute();
    assert.deepEqual(leftover, []);
    assert.deepEqual(groups, []);
    assert.deepEqual(ghost, []);

    const row = await db
      .selectFrom("users")
      .select(["is_ghost", "email", "deleted_at"])
      .where("id", "=", solo.id)
      .executeTakeFirstOrThrow();
    assert.equal(row.is_ghost, 1);
    assert.equal(row.email, null);
    assert.ok(row.deleted_at);

    const replay = await app.request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${solo.token}` },
    });
    assert.equal(replay.status, 401);
  });
});
