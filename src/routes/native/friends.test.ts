/**
 * Friends: the explicit/derived split, invites, and one-on-one expenses.
 *
 * The rules worth pinning down here are the ones that are easy to break and
 * only show up as a wrong balance much later:
 *
 *   - adding a friend creates a real user row, so an expense can name them now
 *   - removing a friendship never moves money
 *   - a one-on-one expense may only involve the two people in it
 *   - a ghost invited at an address can still claim that same address
 *
 * DATABASE_PATH is set before importing anything that opens the database,
 * because src/db/index.ts opens a connection at module load.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-friends-test-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense } = await import("../../domain/expenses.ts");
const { listRelatedUserIds, addFriendship, friendPair } = await import(
  "../../domain/friends.ts"
);

let apiToken: string;
let aliceId: number;
let bobId: number;
let groupId: number;

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  const alice = await db
    .insertInto("users")
    .values({
      email: "alice@example.com",
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      first_name: "Alice",
      last_name: "Anderson",
      default_currency: "USD",
      is_ghost: 0,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  aliceId = alice.id;

  // Bob shares a group with Alice but no friendships row: a DERIVED friend.
  const bob = await db
    .insertInto("users")
    .values({ first_name: "Bob", last_name: "Brown", default_currency: "USD", is_ghost: 1 })
    .returning("id")
    .executeTakeFirstOrThrow();
  bobId = bob.id;

  const group = await db
    .insertInto("groups")
    .values({ name: "Test Trip", group_type: "trip", default_currency: "USD", created_by: aliceId })
    .returning("id")
    .executeTakeFirstOrThrow();
  groupId = group.id;

  await db
    .insertInto("group_members")
    .values([
      { group_id: groupId, user_id: aliceId, role: "owner", joined_via: "creator" },
      { group_id: groupId, user_id: bobId, role: "member", joined_via: "invite_link" },
    ])
    .execute();

  await createExpense({
    groupId,
    description: "Dinner",
    costMinor: 3000,
    currencyCode: "USD",
    date: "2026-08-01",
    splitType: "equal",
    createdBy: aliceId,
    participants: [
      { userId: aliceId, paidMinor: 3000 },
      { userId: bobId, paidMinor: 0 },
    ],
  });

  apiToken = (await createApiToken(aliceId, "test")).token;
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function authed(path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("friendships are stored canonically", () => {
  test("friendPair orders the ids either way round", () => {
    assert.deepEqual(friendPair(9, 4), { userAId: 4, userBId: 9 });
    assert.deepEqual(friendPair(4, 9), { userAId: 4, userBId: 9 });
  });

  test("a user cannot befriend themselves", () => {
    assert.throws(() => friendPair(3, 3));
  });

  test("adding the same friendship twice is a no-op, not an error", async () => {
    await addFriendship(db, aliceId, bobId);
    await addFriendship(db, bobId, aliceId);

    const rows = await db
      .selectFrom("friendships")
      .selectAll()
      .where("user_a_id", "=", Math.min(aliceId, bobId))
      .where("user_b_id", "=", Math.max(aliceId, bobId))
      .execute();
    assert.equal(rows.length, 1);

    await db.deleteFrom("friendships").execute();
  });
});

describe("who counts as a friend", () => {
  test("sharing a group is enough (no friendships row needed)", async () => {
    const ids = await listRelatedUserIds(db, aliceId);
    assert.ok(ids.includes(bobId));
  });

  test("never includes yourself", async () => {
    const ids = await listRelatedUserIds(db, aliceId);
    assert.ok(!ids.includes(aliceId));
  });

  test("the list reports derived friends as not removable", async () => {
    const res = await authed("/api/v1/friends");
    const body = (await res.json()) as { friends: Array<{ id: number; is_explicit: boolean }> };
    const bob = body.friends.find((f) => f.id === bobId);
    assert.equal(bob?.is_explicit, false);
  });
});

describe("adding a friend", () => {
  test("creates a real user row that can be named on an expense", async () => {
    const res = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ firstName: "Carol", lastName: "Chen" }),
    });
    assert.equal(res.status, 201);

    const body = (await res.json()) as {
      friend: { id: number; is_ghost: number; email: string | null };
      recoveryCode?: string;
    };
    assert.equal(body.friend.is_ghost, 1);
    assert.equal(body.friend.email, null);
    // Shown once. Without it a name-only friend could never be handed over.
    assert.ok(body.recoveryCode);

    const expense = await authed(`/api/v1/friends/${body.friend.id}/expenses`, {
      method: "POST",
      body: JSON.stringify({
        description: "Coffee",
        costMinor: 800,
        currencyCode: "USD",
        date: "2026-08-02",
        splitType: "equal",
        participants: [
          { userId: aliceId, paidMinor: 800 },
          { userId: body.friend.id, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(expense.status, 201);
  });

  test("an existing account is linked, not duplicated", async () => {
    const dave = await db
      .insertInto("users")
      .values({
        email: "dave@example.com",
        password_hash: "scrypt$131072$8$1$AAAA$AAAA",
        first_name: "Dave",
        default_currency: "USD",
        is_ghost: 0,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await authed("/api/v1/friends", {
      method: "POST",
      // A different name on purpose: theirs must win over whatever was typed.
      body: JSON.stringify({ firstName: "Davey", email: "dave@example.com" }),
    });

    const body = (await res.json()) as {
      friend: { id: number; first_name: string };
      existingAccount: boolean;
      recoveryCode?: string;
    };
    assert.equal(body.existingAccount, true);
    assert.equal(body.friend.id, dave.id);
    assert.equal(body.friend.first_name, "Dave");
    // No new account, so there is no code to hand out.
    assert.equal(body.recoveryCode, undefined);
  });

  test("refuses your own address", async () => {
    const res = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ firstName: "Me", email: "alice@example.com" }),
    });
    assert.equal(res.status, 400);
  });

  test("a ghost invited at an address can still claim that same address", async () => {
    const added = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ firstName: "Erin", email: "erin@example.com" }),
    });
    const { friend, recoveryCode } = (await added.json()) as {
      friend: { id: number };
      recoveryCode: string;
    };

    // Sign in as the ghost using the code from the invite email.
    const recovered = await app.request("/api/v1/invite/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recoveryCode }),
    });
    assert.equal(recovered.status, 200);
    const cookie = recovered.headers.get("set-cookie")!.split(";")[0]!;

    // The ghost already holds erin@example.com. Claiming it must not collide
    // with itself; this is the whole reason /invite/claim excludes self.
    const claimed = await app.request("/api/v1/invite/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ email: "erin@example.com", password: "longenoughpassword" }),
    });
    assert.equal(claimed.status, 200);

    const row = await db
      .selectFrom("users")
      .select(["id", "is_ghost", "email"])
      .where("id", "=", friend.id)
      .executeTakeFirstOrThrow();
    // Upgraded IN PLACE: same row, so nothing they owe has moved.
    assert.equal(row.is_ghost, 0);
    assert.equal(row.email, "erin@example.com");
  });
});

describe("one-on-one expenses", () => {
  let frankId: number;

  before(async () => {
    const res = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ firstName: "Frank" }),
    });
    frankId = ((await res.json()) as { friend: { id: number } }).friend.id;
  });

  test("belong to no group", async () => {
    await authed(`/api/v1/friends/${frankId}/expenses`, {
      method: "POST",
      body: JSON.stringify({
        description: "Taxi",
        costMinor: 2000,
        currencyCode: "USD",
        date: "2026-08-03",
        splitType: "equal",
        participants: [
          { userId: aliceId, paidMinor: 2000 },
          { userId: frankId, paidMinor: 0 },
        ],
      }),
    });

    const expense = await db
      .selectFrom("expenses")
      .select(["group_id", "cost_minor"])
      .where("description", "=", "Taxi")
      .executeTakeFirstOrThrow();
    assert.equal(expense.group_id, null);
  });

  test("reject a third person", async () => {
    const res = await authed(`/api/v1/friends/${frankId}/expenses`, {
      method: "POST",
      body: JSON.stringify({
        description: "Sneaky",
        costMinor: 3000,
        currencyCode: "USD",
        date: "2026-08-04",
        splitType: "equal",
        participants: [
          { userId: aliceId, paidMinor: 3000 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(res.status, 400);
  });

  test("a payment nets off against what is owed", async () => {
    const before = await balanceWith(frankId);
    assert.equal(before, 1000); // Frank owes half of the 20.00 taxi.

    const res = await authed(`/api/v1/friends/${frankId}/payments`, {
      method: "POST",
      body: JSON.stringify({ direction: "they_paid", amountMinor: 1000, currencyCode: "USD" }),
    });
    assert.equal(res.status, 201);

    assert.equal(await balanceWith(frankId), undefined);
  });

  test("the breakdown separates group history from one-on-one", async () => {
    const res = await authed("/api/v1/friends");
    const body = (await res.json()) as {
      friends: Array<{
        id: number;
        breakdown: Array<{ groupId: number | null; groupName: string | null }>;
      }>;
    };
    const bob = body.friends.find((f) => f.id === bobId);
    assert.deepEqual(
      bob?.breakdown.map((b) => [b.groupId, b.groupName]),
      [[groupId, "Test Trip"]],
    );
  });
});

describe("removing a friend", () => {
  test("never moves a balance, and a shared group keeps them visible", async () => {
    await addFriendship(db, aliceId, bobId);

    const beforeBalance = await balanceWith(bobId);
    const res = await authed(`/api/v1/friends/${bobId}`, { method: "DELETE" });
    const body = (await res.json()) as { stillVisible: boolean };

    // Bob is still in the group, so he stays on the list; you cannot un-owe
    // someone by unfriending them.
    assert.equal(body.stillVisible, true);
    assert.equal(await balanceWith(bobId), beforeBalance);
  });
});

/** Alice's net USD position with one other person, or undefined if settled. */
async function balanceWith(otherUserId: number): Promise<number | undefined> {
  const { getBalanceBetween } = await import("../../domain/balances.ts");
  const balances = await getBalanceBetween(db, aliceId, otherUserId);
  return balances.find((b) => b.currencyCode === "USD")?.amountMinor;
}
