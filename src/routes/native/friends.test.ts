/**
 * Friends: the explicit/derived split, invites, and one-on-one expenses.
 *
 * The rules worth pinning down here are the ones that are easy to break and
 * only show up as a wrong balance much later:
 *
 *   - adding a friend creates a real user row, so an expense can name them now
 *   - removing a friendship never moves money
 *   - a one-on-one expense may only involve the two people in it
 *   - a ghost invited at an address can still register at that same address
 *     (`invite_email` is not `users.email`, so it cannot squat the login index)
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
const { tokenFromVerifyUrl } = await import("../../email/signup.ts");
const { createExpense } = await import("../../domain/expenses.ts");
const { listRelatedUserIds, addFriendship, friendPair } = await import(
  "../../domain/friends.ts"
);
const { ulid } = await import("../../domain/ulid.ts");
const { FRIEND_INVITES_PER_DAY } = await import("../../email/friend-invite.ts");

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
      name: "Alice Anderson",
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
      name: "Bob Brown",
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
    await addFriendship(aliceId, bobId);
    await addFriendship(bobId, aliceId);

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
  test("the list is newest shared expense first, not name or id", async () => {
    const olderId = ulid();
    const newerId = ulid();
    await db
      .insertInto("users")
      .values([
        { id: olderId, name: "AAA Older", default_currency: "USD", is_ghost: 1 },
        { id: newerId, name: "ZZZ Newer", default_currency: "USD", is_ghost: 1 },
      ])
      .execute();
    await addFriendship(aliceId, olderId);
    await addFriendship(aliceId, newerId);

    const t = Date.now();
    await createExpense({
      id: ulid(t),
      description: "Older coffee",
      costMinor: 400,
      currencyCode: "USD",
      date: "2026-08-01",
      splitType: "equal",
      createdBy: aliceId,
      participants: [
        { userId: aliceId, paidMinor: 400 },
        { userId: olderId, paidMinor: 0 },
      ],
    });
    await createExpense({
      id: ulid(t + 60_000),
      description: "Newer coffee",
      costMinor: 500,
      currencyCode: "USD",
      date: "2026-07-01",
      splitType: "equal",
      createdBy: aliceId,
      participants: [
        { userId: aliceId, paidMinor: 500 },
        { userId: newerId, paidMinor: 0 },
      ],
    });

    const res = await authed("/api/v1/friends");
    const body = (await res.json()) as { friends: Array<{ id: string }> };
    const ids = body.friends.map((f) => f.id);
    // AAA Older would win a name sort; ZZZ Newer has the later bill.
    assert.ok(ids.indexOf(newerId) < ids.indexOf(olderId));
  });

  test("same-millisecond last expenses break by name, then id", async () => {
    const annId = ulid();
    const bobIdFriend = ulid();
    await db
      .insertInto("users")
      .values([
        { id: bobIdFriend, name: "Bob SameMs", default_currency: "USD", is_ghost: 1 },
        { id: annId, name: "Ann SameMs", default_currency: "USD", is_ghost: 1 },
      ])
      .execute();
    await addFriendship(aliceId, bobIdFriend);
    await addFriendship(aliceId, annId);

    const t = Date.now();
    await createExpense({
      id: ulid(t),
      description: "Ann coffee",
      costMinor: 400,
      currencyCode: "USD",
      date: "2026-08-01",
      splitType: "equal",
      createdBy: aliceId,
      participants: [
        { userId: aliceId, paidMinor: 400 },
        { userId: annId, paidMinor: 0 },
      ],
    });
    await createExpense({
      id: ulid(t),
      description: "Bob coffee",
      costMinor: 500,
      currencyCode: "USD",
      date: "2026-08-01",
      splitType: "equal",
      createdBy: aliceId,
      participants: [
        { userId: aliceId, paidMinor: 500 },
        { userId: bobIdFriend, paidMinor: 0 },
      ],
    });

    const res = await authed("/api/v1/friends");
    const body = (await res.json()) as { friends: Array<{ id: string; name: string }> };
    const ids = body.friends.map((f) => f.id);
    assert.ok(ids.indexOf(annId) < ids.indexOf(bobIdFriend));
  });

  test("an import rounding settle-up does not bump a friend to the top", async () => {
    const settledId = ulid();
    const recentId = ulid();
    await db
      .insertInto("users")
      .values([
        { id: settledId, name: "Settled Long Ago", default_currency: "USD", is_ghost: 1 },
        { id: recentId, name: "Recent Friend", default_currency: "USD", is_ghost: 1 },
      ])
      .execute();
    await addFriendship(aliceId, settledId);
    await addFriendship(aliceId, recentId);

    const t = Date.now();
    await createExpense({
      id: ulid(t),
      description: "Old dinner",
      costMinor: 400,
      currencyCode: "USD",
      date: "2022-12-13",
      splitType: "equal",
      createdBy: aliceId,
      participants: [
        { userId: aliceId, paidMinor: 400 },
        { userId: settledId, paidMinor: 0 },
      ],
    });
    await createExpense({
      id: ulid(t + 60_000),
      description: "Recent coffee",
      costMinor: 500,
      currencyCode: "USD",
      date: "2026-08-01",
      splitType: "equal",
      createdBy: aliceId,
      participants: [
        { userId: aliceId, paidMinor: 500 },
        { userId: recentId, paidMinor: 0 },
      ],
    });
    const { IMPORT_ROUNDING_DETAILS } = await import("../../domain/metadata.ts");
    await createExpense({
      id: ulid(t + 120_000),
      description: "Payment",
      details: IMPORT_ROUNDING_DETAILS,
      costMinor: 1,
      currencyCode: "JPY",
      date: "2026-08-23",
      splitType: "exact",
      isPayment: true,
      createdBy: aliceId,
      metadata: { import_rounding: true },
      participants: [
        { userId: aliceId, paidMinor: 0, input: 1 },
        { userId: settledId, paidMinor: 1, input: 0 },
      ],
    });

    const res = await authed("/api/v1/friends");
    const body = (await res.json()) as { friends: Array<{ id: string }> };
    const ids = body.friends.map((f) => f.id);
    assert.ok(ids.indexOf(recentId) < ids.indexOf(settledId));
  });

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
      body: JSON.stringify({ name: "Carol Chen" }),
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
        name: "Dave",
        default_currency: "USD",
        is_ghost: 0,
      })
      .execute();

    const res = await authed("/api/v1/friends", {
      method: "POST",
      // A different name on purpose: theirs must win over whatever was typed.
      body: JSON.stringify({ name: "Davey", email: "dave@example.com" }),
    });

    const body = (await res.json()) as {
      friend: { id: string; name: string };
      existingAccount: boolean;
      inviteUrl?: string;
    };
    assert.equal(body.existingAccount, true);
    assert.equal(body.friend.id, daveId);
    assert.equal(body.friend.name, "Dave");
    // They log in as themselves; a guest link would be a way to impersonate a
    // real account, which access-links.ts refuses to mint.
    assert.equal(body.inviteUrl, undefined);
  });

  test("refuses your own address", async () => {
    const res = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ name: "Me", email: "alice@example.com" }),
    });
    assert.equal(res.status, 400);
  });

  test("the invite link reaches the placeholder, and only the placeholder", async () => {
    const added = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ name: "Erin", email: "erin@example.com" }),
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

  test("an invite address does not occupy the login unique index", async () => {
    const added = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ name: "Squat", email: "squat@example.com" }),
    });
    assert.equal(added.status, 201);
    const { friend } = (await added.json()) as {
      friend: { id: string; email: string | null; is_ghost: number };
    };
    assert.equal(friend.email, "squat@example.com", "the list still shows the invite address");
    assert.equal(friend.is_ghost, 1);

    const stored = await db
      .selectFrom("users")
      .select(["email", "invite_email"])
      .where("id", "=", friend.id)
      .executeTakeFirstOrThrow();
    assert.equal(stored.email, null);
    assert.equal(stored.invite_email, "squat@example.com");

    const start = await app.request("/api/v1/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "squat@example.com" }),
    });
    assert.equal(start.status, 200);
    const started = (await start.json()) as { verifyUrl: string };
    const registered = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: tokenFromVerifyUrl(started.verifyUrl),
        password: "hunter2hunter2",
        name: "The Real Squat",
      }),
    });
    assert.equal(registered.status, 201, "inviting someone must not block them from signing up");
  });

  test("the same owner inviting the same address twice gets the same ghost", async () => {
    const first = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ name: "Pat", email: "pat@example.com" }),
    });
    const second = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ name: "Patricia", email: "pat@example.com" }),
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const a = (await first.json()) as { friend: { id: string; name: string } };
    const b = (await second.json()) as {
      friend: { id: string; name: string };
      existingAccount: boolean;
    };
    assert.equal(b.friend.id, a.friend.id);
    assert.equal(b.existingAccount, false, "they are still a placeholder, not an account");
    assert.equal(b.friend.name, "Pat", "the first name stays; this is not a rename");
  });

  test("a second owner inviting the same address gets their own ghost", async () => {
    const otherId = ulid();
    await db
      .insertInto("users")
      .values({
        id: otherId,
        email: "other-owner@example.com",
        password_hash: "scrypt$131072$8$1$AAAA$AAAA",
        name: "Other Owner",
        default_currency: "USD",
        is_ghost: 0,
      })
      .execute();
    const otherToken = (await createApiToken(otherId, "test")).token;

    const aliceFriend = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ name: "Shared Inbox", email: "shared-inbox@example.com" }),
    });
    const otherFriend = await app.request("/api/v1/friends", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otherToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Also Shared", email: "shared-inbox@example.com" }),
    });
    assert.equal(aliceFriend.status, 201);
    assert.equal(otherFriend.status, 201);
    const aliceBody = (await aliceFriend.json()) as { friend: { id: string } };
    const otherBody = (await otherFriend.json()) as { friend: { id: string } };
    assert.notEqual(otherBody.friend.id, aliceBody.friend.id);
  });
});

describe("one-on-one expenses", () => {
  let frankId: string;

  before(async () => {
    const res = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ name: "Frank" }),
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

describe("editing a placeholder", () => {
  test("a related account can set a ghost's name and icon", async () => {
    const res = await authed(`/api/v1/friends/${bobId}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: "Robert Brown",
        nickname: "Bobby",
        iconEmoji: "🦊",
        iconHue: 32,
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      friend: { name: string; nickname: string | null; icon_emoji: string | null; icon_hue: number | null };
    };
    assert.equal(body.friend.name, "Robert Brown");
    assert.equal(body.friend.nickname, "Bobby");
    assert.equal(body.friend.icon_emoji, "🦊");
    assert.equal(body.friend.icon_hue, 32);
  });

  test("can set and clear a ghost's invite address", async () => {
    const set = await authed(`/api/v1/friends/${bobId}`, {
      method: "PATCH",
      body: JSON.stringify({ email: "bob-invite@example.com" }),
    });
    assert.equal(set.status, 200);
    const setBody = (await set.json()) as {
      friend: { email: string | null };
      inviteUrl?: string;
      emailDelivered?: boolean;
    };
    assert.equal(setBody.friend.email, "bob-invite@example.com");
    assert.equal(setBody.inviteUrl, undefined);
    assert.equal(setBody.emailDelivered, undefined);

    const stored = await db
      .selectFrom("users")
      .select(["email", "invite_email"])
      .where("id", "=", bobId)
      .executeTakeFirstOrThrow();
    assert.equal(stored.email, null);
    assert.equal(stored.invite_email, "bob-invite@example.com");

    const sends = await db
      .selectFrom("email_sends")
      .select("id")
      .where("type", "=", "invite")
      .where("subject_user_id", "=", bobId)
      .execute();
    assert.equal(sends.length, 0, "saving an address must not send mail");

    const cleared = await authed(`/api/v1/friends/${bobId}`, {
      method: "PATCH",
      body: JSON.stringify({ email: "" }),
    });
    assert.equal(cleared.status, 200);
    const clearedBody = (await cleared.json()) as {
      friend: { email: string | null };
      inviteUrl?: string;
    };
    assert.equal(clearedBody.friend.email, null);
    assert.equal(clearedBody.inviteUrl, undefined);
  });

  test("refuses your own address and a live account's address", async () => {
    const own = await authed(`/api/v1/friends/${bobId}`, {
      method: "PATCH",
      body: JSON.stringify({ email: "alice@example.com" }),
    });
    assert.equal(own.status, 400);

    const liveId = ulid();
    await db
      .insertInto("users")
      .values({
        id: liveId,
        email: "already-joined@example.com",
        password_hash: "scrypt$131072$8$1$AAAA$AAAA",
        name: "Already Joined",
        default_currency: "USD",
        is_ghost: 0,
      })
      .execute();
    const taken = await authed(`/api/v1/friends/${bobId}`, {
      method: "PATCH",
      body: JSON.stringify({ email: "already-joined@example.com" }),
    });
    assert.equal(taken.status, 400);
  });

  test("refuses a second placeholder at an address this owner already invited", async () => {
    const first = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ name: "Invite One", email: "invite-one@example.com" }),
    });
    const second = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ name: "Invite Two", email: "invite-two@example.com" }),
    });
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    const { friend } = (await second.json()) as { friend: { id: string } };

    const clash = await authed(`/api/v1/friends/${friend.id}`, {
      method: "PATCH",
      body: JSON.stringify({ email: "invite-one@example.com" }),
    });
    assert.equal(clash.status, 409);
  });

  test("resending an invite uses the stored address and the live guest link", async () => {
    const added = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ name: "Resend Me", email: "resend-me@example.com" }),
    });
    const { friend, inviteUrl } = (await added.json()) as {
      friend: { id: string };
      inviteUrl: string;
    };

    const nameless = await authed("/api/v1/friends", {
      method: "POST",
      body: JSON.stringify({ name: "No Mail" }),
    });
    const { friend: noMail } = (await nameless.json()) as { friend: { id: string } };
    const missing = await authed(`/api/v1/friends/${noMail.id}/invite`, { method: "POST" });
    assert.equal(missing.status, 400);

    const resent = await authed(`/api/v1/friends/${friend.id}/invite`, { method: "POST" });
    assert.equal(resent.status, 200);
    const body = (await resent.json()) as { inviteUrl: string; emailDelivered: boolean };
    assert.equal(body.inviteUrl, inviteUrl, "resend must not rotate the live link");
    assert.equal(body.emailDelivered, false);

    const again = await authed(`/api/v1/friends/${friend.id}/invite`, { method: "POST" });
    assert.equal(again.status, 429);
    const againBody = (await again.json()) as { error: string; retryAfterSeconds: number };
    assert.match(againBody.error, /24 hours/i);
    assert.ok(againBody.retryAfterSeconds >= 1);
  });

  test("caps invite emails at three per user per UTC day", async () => {
    const senderId = ulid();
    await db
      .insertInto("users")
      .values({
        id: senderId,
        email: "quota@example.com",
        password_hash: "scrypt$131072$8$1$AAAA$AAAA",
        name: "Quota Owner",
        default_currency: "USD",
        is_ghost: 0,
      })
      .execute();
    const token = (await createApiToken(senderId, "quota")).token;
    const asSender = (path: string, init: RequestInit = {}) =>
      app.request(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });

    async function addAndInvite(name: string, email: string) {
      const added = await asSender("/api/v1/friends", {
        method: "POST",
        body: JSON.stringify({ name, email }),
      });
      assert.equal(added.status, 201);
      const { friend } = (await added.json()) as { friend: { id: string } };
      const sent = await asSender(`/api/v1/friends/${friend.id}/invite`, { method: "POST" });
      return { friendId: friend.id, sent };
    }

    const first = await addAndInvite("Quota Ghost 0", "quota-ghost-0@example.com");
    assert.equal(first.sent.status, 200, "first friend in 24h");

    const afterAdd = await db
      .selectFrom("email_sends")
      .select(["id", "type", "actor_user_id", "subject_user_id"])
      .where("actor_user_id", "=", senderId)
      .execute();
    assert.equal(afterAdd.length, 1);
    assert.equal(afterAdd[0]?.type, "invite");
    assert.equal(afterAdd[0]?.subject_user_id, first.friendId);

    for (let i = 1; i < FRIEND_INVITES_PER_DAY; i++) {
      const next = await addAndInvite(`Quota Ghost ${i}`, `quota-ghost-${i}@example.com`);
      assert.equal(next.sent.status, 200, `friend ${i + 1} should succeed`);
    }

    const fourth = await addAndInvite("Quota Ghost 3", "quota-ghost-3@example.com");
    assert.equal(fourth.sent.status, 429);
    const blockedBody = (await fourth.sent.json()) as { error: string; retryAfterSeconds: number };
    assert.match(blockedBody.error, /3 invites per day/i);
    assert.ok(blockedBody.retryAfterSeconds >= 1);
    assert.ok(fourth.sent.headers.get("Retry-After"));

    const patched = await asSender(`/api/v1/friends/${first.friendId}`, {
      method: "PATCH",
      body: JSON.stringify({ email: "quota-ghost-patched@example.com" }),
    });
    assert.equal(patched.status, 200);
    const afterPatch = await db
      .selectFrom("email_sends")
      .select("id")
      .where("actor_user_id", "=", senderId)
      .where("type", "=", "invite")
      .execute();
    assert.equal(afterPatch.length, FRIEND_INVITES_PER_DAY, "PATCH must not consume or refund a slot");
  });

  test("refuses to edit a real account", async () => {
    const daveId = ulid();
    await db
      .insertInto("users")
      .values({
        id: daveId,
        email: "dave-edit@example.com",
        password_hash: "scrypt$131072$8$1$AAAA$AAAA",
        name: "Dave",
        default_currency: "USD",
        is_ghost: 0,
      })
      .execute();
    await addFriendship(aliceId, daveId);

    const res = await authed(`/api/v1/friends/${daveId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "David" }),
    });
    assert.equal(res.status, 403);
  });
});

describe("removing a friend", () => {
  test("never moves a balance, and a shared group keeps them visible", async () => {
    await addFriendship(aliceId, bobId);

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
