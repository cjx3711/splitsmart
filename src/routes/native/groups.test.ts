/**
 * Group membership: who may add, who may remove, and what must not happen.
 *
 * Opening a guest link no longer creates a member, so `POST /groups/:id/members`
 * is the only way names get into a group. That makes the "guess a ULID" check
 * load-bearing: without it this endpoint attaches a stranger's account to your
 * ledger. The last-owner and "members cannot remove others" rules are the same
 * class of quiet disaster — a group with no owner, or a member kicking the
 * person who minted the guest links.
 *
 * DATABASE_PATH is set before importing anything that reaches src/db/index.ts.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-groups-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { ulid } = await import("../../domain/ulid.ts");

let ownerId: string;
let memberId: string;
let strangerId: string;
let ownerToken: string;
let memberToken: string;
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

function as(token: string, path: string, init: RequestInit = {}) {
  return app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  ownerId = await realUser("Olive", "olive@example.com");
  memberId = await realUser("Mina", "mina@example.com");
  strangerId = await realUser("Sid", "sid@example.com");
  ownerToken = (await createApiToken(ownerId, "test")).token;
  memberToken = (await createApiToken(memberId, "test")).token;

  groupId = ulid();
  await db
    .insertInto("groups")
    .values({ id: groupId, name: "Flat", group_type: "home", default_currency: "USD", created_by: ownerId })
    .execute();
  await db
    .insertInto("group_members")
    .values([
      { group_id: groupId, user_id: ownerId, role: "owner", joined_via: "creator" },
      { group_id: groupId, user_id: memberId, role: "member", joined_via: "added" },
    ])
    .execute();
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("adding members", () => {
  test("cannot attach a stranger by guessing their ULID", async () => {
    const res = await as(ownerToken, `/groups/${groupId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId: strangerId }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /already share history/i);

    const row = await db
      .selectFrom("group_members")
      .select("user_id")
      .where("group_id", "=", groupId)
      .where("user_id", "=", strangerId)
      .executeTakeFirst();
    assert.equal(row, undefined);
  });
});

describe("removing members", () => {
  test("a member cannot remove someone else", async () => {
    const res = await as(memberToken, `/groups/${groupId}/members/${ownerId}`, { method: "DELETE" });
    assert.equal(res.status, 403);

    const still = await db
      .selectFrom("group_members")
      .select("left_at")
      .where("group_id", "=", groupId)
      .where("user_id", "=", ownerId)
      .executeTakeFirstOrThrow();
    assert.equal(still.left_at, null);
  });

  test("the last owner cannot leave", async () => {
    const res = await as(ownerToken, `/groups/${groupId}/members/${ownerId}`, { method: "DELETE" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /needs an owner/i);

    const still = await db
      .selectFrom("group_members")
      .select(["role", "left_at"])
      .where("group_id", "=", groupId)
      .where("user_id", "=", ownerId)
      .executeTakeFirstOrThrow();
    assert.equal(still.role, "owner");
    assert.equal(still.left_at, null);
  });
});
