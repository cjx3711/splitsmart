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
const { ulid } = await import("../../domain/ulid.ts");

let apiToken: string;
let aliceId: string;
let bobId: string;
let groupId: string;

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
      first_name: "Alice",
      last_name: "Anderson",
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();

  // Bob shares a group with Alice but no friendships row: a DERIVED friend.
  bobId = ulid();
  await db
    .insertInto("users")
    .values({
      id: bobId,
      first_name: "Bob",
      last_name: "Brown",
      default_currency: "USD",
      is_ghost: 1,
    })
    .execute();

  groupId = ulid();
  await db
    .insertInto("groups")
    .values({
      id: groupId,
      name: "Test Trip",
      group_type: "trip",
      default_currency: "USD",
      created_by: aliceId,
    })
    .execute();

  await db
    .insertInto("group_members")
    .values([
      { group_id: groupId, user_id: aliceId, role: "owner", joined_via: "creator" },
      { group_id: groupId, user_id: bobId, role: "member", joined_via: "added" },
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
    const a = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
    const b = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
    assert.deepEqual(friendPair(b, a), { userAId: a, userBId: b });
    assert.deepEqual(friendPair(a, b), { userAId: a, userBId: b });
  });

  test("a user cannot befriend themselves", () => {
    assert.throws(() => friendPair("01ARZ3NDEKTSV4RRFFQ69G5FAA", "01ARZ3NDEKTSV4RRFFQ69G5FAA"));
  });

  test("adding the same friendship twice is a no-op, not an error", async () => {
    await addFriendship(db, aliceId, bobId);
    await addFriendship(db, bobId, aliceId);

    const { userAId, userBId } = friendPair(aliceId, bobId);
    const rows = await db
      .selectFrom("friendships")
      .selectAll()
      .where("user_a_id", "=", userAId)
      .where("user_b_id", "=", userBId)
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
    const body = (await res.json()) as { friends: Array<{ id: string; is_explicit: boolean }> };
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
      friend: { id: string; is_ghost: number; email: string | null };
      inviteUrl?: string;
    };
    assert.equal(body.friend.is_ghost, 1);
    assert.equal(body.friend.email, null);
    // Returned once. Only the hash is stored, so without surfacing it here a
    // name-only friend could never be handed the link at all.
    assert.match(body.inviteUrl ?? "", /\/guest\/l\/.+/);

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
    const daveId = ulid();
    await db
      .insertInto("users")
      .values({
        id: daveId,
        email: "dave@example.com",
        password_hash: "scrypt$131072$8$1$AAAA$AAAA",
        first_name: "Dave",
        default_currency: "USD",
        is_ghost: 0,
      })
      .execute();

    const res = await authed("/api/v1/friends", {
      method: "POST",
      // A different name on purpose: theirs must win over whatever was typed.
      body: JSON.stringify({ firstName: "Davey", email: "dave@example.com" }),
    });

    const body = (await res.json()) as {
      friend: { id: string; first_name: string };
      existingAccount: boolean;
      inviteUrl?: string;
    };
    assert.equal(body.existingAccount, true);
    assert.equal(body.friend.id, daveId);
    assert.equal(body.friend.first_name, "Dave");
    // They log in as themselves; a guest link would be a way to impersonate a
    // real account, which access-links.ts refuses to mint.
    assert.equal(body.inviteUrl, undefined);
  });

  test("refuses your own address", async () => {
    const res = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ firstName: "Me", email: "alice@example.com" }),
    });
    assert.equal(res.status, 400);
  });

  test("the invite link reaches the placeholder, and only the placeholder", async () => {
    const added = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ firstName: "Erin", email: "erin@example.com" }),
    });
    const { friend, inviteUrl } = (await added.json()) as {
      friend: { id: string };
      inviteUrl: string;
    };

    const secret = inviteUrl.split("/guest/l/")[1]!;

    const session = await app.request("/api/v1/guest/session", {
      headers: { Authorization: `Bearer link_${secret}` },
    });
    assert.equal(session.status, 200);
    const body = (await session.json()) as {
      kind: string;
      actingAs: { id: string } | null;
      counterpart: { id: string } | null;
    };
    assert.equal(body.kind, "friend");
    assert.equal(body.actingAs?.id, friend.id, "a friend link needs no picker");
    assert.equal(body.counterpart?.id, aliceId, "the far side is whoever minted it");

    // The very same secret is not a user credential. See src/auth/middleware.ts.
    const asUser = await app.request("/api/v1/friends", {
      headers: { Authorization: `Bearer link_${secret}` },
    });
    assert.equal(asUser.status, 401);
  });
});

describe("one-on-one expenses", () => {
  let frankId: string;

  before(async () => {
    const res = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ firstName: "Frank" }),
    });
    frankId = ((await res.json()) as { friend: { id: string } }).friend.id;
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
        id: string;
        breakdown: Array<{ groupId: string | null; groupName: string | null }>;
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
async function balanceWith(otherUserId: string): Promise<number | undefined> {
  const { getBalanceBetween } = await import("../../domain/balances.ts");
  const balances = await getBalanceBetween(db, aliceId, otherUserId);
  return balances.find((b) => b.currencyCode === "USD")?.amountMinor;
}
