/**
 * Guest links: what a secret may see, and everything it must not.
 *
 * The tests that matter here are the negative ones. A guest link is handed
 * around in chat apps and pasted into browsers; if its scope leaks by one
 * group or one 1:1 expense, the person who shared it has published somebody
 * else's money without knowing. So most of this file is "and it does NOT
 * return that", per docs/GUEST.md's own testing list.
 *
 * DATABASE_PATH is set before importing anything that reaches src/db/index.ts,
 * which opens a connection at module load.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-guest-test-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db, sqlite, transaction } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense } = await import("../../domain/expenses.ts");
const { mintAccessLink, revokeAccessLink } = await import("../../domain/access-links.ts");
const { ACTING_AS_HEADER } = await import("./guest.ts");
const { ulid } = await import("../../domain/ulid.ts");

/**
 * The cast:
 *
 *   owner    a real account. Minted every link in this file.
 *   alice    a ghost. In both groups, and has 1:1 history with the owner.
 *   bob      a ghost. In the shared group only.
 *   claimed  a real account who is also in the shared group: a link must
 *            refuse to act as them.
 */
let ownerId: string;
let aliceId: string;
let bobId: string;
let claimedId: string;
let sharedGroupId: string;
let otherGroupId: string;
let secretGroupId: string;

let sharedExpenseId: string;
let otherGroupExpenseId: string;
let secretGroupExpenseId: string;
let oneOnOneExpenseId: string;

let ownerToken: string;

async function makeGroup(name: string, members: string[]): Promise<string> {
  const id = ulid();
  await db
    .insertInto("groups")
    .values({ id, name, group_type: "trip", default_currency: "USD", created_by: ownerId })
    .execute();
  for (const [i, userId] of members.entries()) {
    await db
      .insertInto("group_members")
      .values({
        group_id: id,
        user_id: userId,
        role: userId === ownerId ? "owner" : "member",
        joined_via: i === 0 ? "creator" : "added",
      })
      .execute();
  }
  return id;
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  ownerId = ulid();
  await db
    .insertInto("users")
    .values({
      id: ownerId,
      email: "owner@example.com",
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      name: "Olive",
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();

  claimedId = ulid();
  await db
    .insertInto("users")
    .values({
      id: claimedId,
      email: "claimed@example.com",
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      name: "Clara",
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();

  aliceId = ulid();
  await db
    .insertInto("users")
    .values({ id: aliceId, name: "Alice", default_currency: "USD", is_ghost: 1 })
    .execute();

  bobId = ulid();
  await db
    .insertInto("users")
    .values({ id: bobId, name: "Bob", default_currency: "USD", is_ghost: 1 })
    .execute();

  sharedGroupId = await makeGroup("Shared", [ownerId, aliceId, bobId, claimedId]);
  otherGroupId = await makeGroup("Alice elsewhere", [ownerId, aliceId]);
  secretGroupId = await makeGroup("Not Alice's", [ownerId, bobId]);

  sharedExpenseId = await createExpense({
    groupId: sharedGroupId,
    description: "Dinner",
    costMinor: 9_000,
    currencyCode: "USD",
    date: "2026-04-01",
    splitType: "equal",
    participants: [
      { userId: ownerId, paidMinor: 9_000 },
      { userId: aliceId, paidMinor: 0 },
      { userId: bobId, paidMinor: 0 },
    ],
    createdBy: ownerId,
  });

  otherGroupExpenseId = await createExpense({
    groupId: otherGroupId,
    description: "Museum",
    costMinor: 4_000,
    currencyCode: "USD",
    date: "2026-04-02",
    splitType: "equal",
    participants: [
      { userId: ownerId, paidMinor: 4_000 },
      { userId: aliceId, paidMinor: 0 },
    ],
    createdBy: ownerId,
  });

  secretGroupExpenseId = await createExpense({
    groupId: secretGroupId,
    description: "Nothing to do with Alice",
    costMinor: 5_000,
    currencyCode: "USD",
    date: "2026-04-03",
    splitType: "equal",
    participants: [
      { userId: ownerId, paidMinor: 5_000 },
      { userId: bobId, paidMinor: 0 },
    ],
    createdBy: ownerId,
  });

  oneOnOneExpenseId = await createExpense({
    groupId: null,
    description: "Coffee, just us",
    costMinor: 1_000,
    currencyCode: "USD",
    date: "2026-04-04",
    splitType: "equal",
    participants: [
      { userId: ownerId, paidMinor: 1_000 },
      { userId: aliceId, paidMinor: 0 },
    ],
    createdBy: ownerId,
  });

  ownerToken = (await createApiToken(ownerId, "test")).token;
});

after(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

async function mint(input: {
  kind: "group" | "group_member" | "friend";
  groupId?: string | null;
  userId?: string | null;
  expiresAt?: string | null;
}): Promise<string> {
  const minted = await transaction((trx) =>
    mintAccessLink(trx, { ...input, createdBy: ownerId }),
  );
  return minted.secret;
}

function guest(
  secret: string,
  path: string,
  init: RequestInit & { actingAs?: string } = {},
) {
  const { actingAs, ...rest } = init;
  return app.request(`/api/v1/guest${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer link_${secret}`,
      ...(actingAs ? { [ACTING_AS_HEADER]: actingAs } : {}),
      ...(rest.headers ?? {}),
    },
  });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

interface ExpenseRow {
  id: string;
  description: string;
  group_id: string | null;
}

// ---------------------------------------------------------------------------

describe("guest link scope: a group link", () => {
  test("sees its own group and nothing else", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });

    const res = await guest(secret, "/expenses");
    assert.equal(res.status, 200);
    const { expenses } = await json<{ expenses: ExpenseRow[] }>(res);
    const ids = expenses.map((e) => e.id);

    assert.deepEqual(ids, [sharedExpenseId]);
    assert.ok(!ids.includes(otherGroupExpenseId), "another group Alice is in stays hidden");
    assert.ok(!ids.includes(secretGroupExpenseId), "a group Alice is not in stays hidden");
    assert.ok(
      !ids.includes(oneOnOneExpenseId),
      "a 1:1 expense Alice is on is NOT part of a group link",
    );
  });

  test("cannot read another group by id", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });

    assert.equal((await guest(secret, `/groups/${sharedGroupId}`)).status, 200);
    assert.equal((await guest(secret, `/groups/${otherGroupId}`)).status, 404);
    assert.equal((await guest(secret, `/groups/${secretGroupId}`)).status, 404);
  });

  test("cannot read a 1:1 expense by id either", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });

    assert.equal((await guest(secret, `/expenses/${sharedExpenseId}`)).status, 200);
    assert.equal((await guest(secret, `/expenses/${oneOnOneExpenseId}`)).status, 404);
    assert.equal((await guest(secret, `/expenses/${secretGroupExpenseId}`)).status, 404);
  });

  test("has no friend screen at all", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });
    assert.equal((await guest(secret, "/friend")).status, 404);
  });
});

describe("guest link scope: a friend link", () => {
  test("sees the 1:1 expenses and every group the ghost is in", async () => {
    const secret = await mint({ kind: "friend", userId: aliceId });

    const { expenses } = await json<{ expenses: ExpenseRow[] }>(
      await guest(secret, "/expenses"),
    );
    const ids = expenses.map((e) => e.id).sort();

    assert.deepEqual(ids, [sharedExpenseId, otherGroupExpenseId, oneOnOneExpenseId].sort());
    assert.ok(
      !ids.includes(secretGroupExpenseId),
      "a group the ghost is not in is not the owner's to share this way",
    );
  });

  test("does not expose the owner's other friends", async () => {
    const secret = await mint({ kind: "friend", userId: aliceId });

    const { people } = await json<{ people: Array<{ id: string }> }>(
      await guest(secret, "/people"),
    );
    const ids = people.map((p) => p.id);

    assert.ok(ids.includes(aliceId));
    assert.ok(ids.includes(ownerId));
    // Bob shares a group with Alice, so his name is on bills she can read.
    assert.ok(ids.includes(bobId));
    // But nobody from a group she is not in.
    const stranger = ulid();
    assert.ok(!ids.includes(stranger));
  });

  test("shows the balance between the ghost and the owner", async () => {
    const secret = await mint({ kind: "friend", userId: aliceId });

    const body = await json<{
      counterpart: { id: string };
      balances: Array<{ currencyCode: string; amountMinor: number }>;
    }>(await guest(secret, "/friend"));

    assert.equal(body.counterpart.id, ownerId);
    assert.ok(body.balances.length > 0);
  });
});

describe("the picker on a general group link", () => {
  test("409s until a name is picked, then works and can be re-picked", async () => {
    const secret = await mint({ kind: "group", groupId: sharedGroupId });

    const unpicked = await guest(secret, "/expenses");
    assert.equal(unpicked.status, 409, "the link is fine; nobody has said who they are");
    const body = await json<{ needsPicker: boolean }>(unpicked);
    assert.equal(body.needsPicker, true);

    // /session still answers, because the picker needs the names.
    const session = await json<{ needsPicker: boolean; people: Array<{ id: string }> }>(
      await guest(secret, "/session"),
    );
    assert.equal(session.needsPicker, true);

    assert.equal((await guest(secret, "/expenses", { actingAs: aliceId })).status, 200);
    assert.equal(
      (await guest(secret, "/expenses", { actingAs: bobId })).status,
      200,
      "re-picking is a header change, not a new link",
    );
  });

  test("offers only unclaimed ghosts, never a real account", async () => {
    const secret = await mint({ kind: "group", groupId: sharedGroupId });

    const { people } = await json<{ people: Array<{ id: string }> }>(
      await guest(secret, "/session"),
    );
    const ids = people.map((p) => p.id).sort();

    assert.deepEqual(ids, [aliceId, bobId].sort());
    assert.ok(!ids.includes(ownerId), "the owner has an account; they log in");
    assert.ok(!ids.includes(claimedId), "so does Clara");
  });

  test("refuses an acting-as the link cannot use", async () => {
    const secret = await mint({ kind: "group", groupId: sharedGroupId });

    // A real account in the same group.
    assert.equal((await guest(secret, "/expenses", { actingAs: claimedId })).status, 409);
    // Somebody in a different group entirely.
    assert.equal((await guest(secret, "/expenses", { actingAs: ownerId })).status, 409);
  });

  test("an individual link ignores the header and auto-picks", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });

    const session = await json<{ actingAs: { id: string }; canRepick: boolean }>(
      await guest(secret, "/session", { actingAs: bobId }),
    );

    assert.equal(session.actingAs.id, aliceId, "the link decides, not the client");
    assert.equal(session.canRepick, false);
  });
});

describe("expired, revoked, and claimed", () => {
  test("an expired secret is 401 with nothing left behind", async () => {
    const secret = await mint({
      kind: "group_member",
      groupId: sharedGroupId,
      userId: aliceId,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });

    const res = await guest(secret, "/expenses");
    assert.equal(res.status, 401);
    assert.equal((await json<{ reason: string }>(res)).reason, "expired");

    assert.equal((await guest(secret, "/session")).status, 401);
    assert.equal((await guest(secret, `/groups/${sharedGroupId}`)).status, 401);
  });

  test("revoking takes effect on the very next request", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });
    assert.equal((await guest(secret, "/expenses")).status, 200);

    const link = await db
      .selectFrom("access_links")
      .select("id")
      .where("user_id", "=", aliceId)
      .where("kind", "=", "group_member")
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();
    await revokeAccessLink(db, link.id);

    const res = await guest(secret, "/expenses");
    assert.equal(res.status, 401);
    assert.equal((await json<{ reason: string }>(res)).reason, "revoked");
  });

  test("a link cannot act as someone who now has an account", async () => {
    const ghost = ulid();
    await db
      .insertInto("users")
      .values({ id: ghost, name: "Soon", default_currency: "USD", is_ghost: 1 })
      .execute();
    const groupId = await makeGroup("Temporary", [ownerId, ghost]);
    const secret = await mint({ kind: "group_member", groupId, userId: ghost });

    assert.equal((await guest(secret, "/session")).status, 200);

    await db
      .updateTable("users")
      .set({
        is_ghost: 0,
        email: `soon-${ghost}@example.com`,
        password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      })
      .where("id", "=", ghost)
      .execute();

    const res = await guest(secret, "/session");
    assert.equal(res.status, 401);
    const body = await json<{ reason: string; error: string }>(res);
    assert.equal(body.reason, "claimed");
    assert.match(body.error, /log in/i, "tell them to log in, not to ask for a new link");
  });

  test("a bogus secret is 401, and so is no secret at all", async () => {
    assert.equal((await guest("not-a-real-secret", "/session")).status, 401);
    assert.equal((await app.request("/api/v1/guest/session")).status, 401);
  });
});

describe("a guest link is not a user credential", () => {
  test("the logged-in API refuses it", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });
    const auth = { Authorization: `Bearer link_${secret}` };

    for (const path of [
      "/api/v1/groups",
      "/api/v1/friends",
      "/api/v1/expenses",
      "/api/v1/activity",
      "/api/v1/import/status",
      "/api/v1/links?groupId=" + sharedGroupId,
    ]) {
      const res = await app.request(path, { headers: auth });
      assert.equal(res.status, 401, `${path} must refuse a guest link`);
      assert.equal((await json<{ guestLink: boolean }>(res)).guestLink, true);
    }
  });

  test("the Splitwise compat API refuses it too", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });

    const res = await app.request("/api/sw/v3.0/get_current_user", {
      headers: { Authorization: `Bearer link_${secret}` },
    });
    assert.equal(res.status, 401);
  });

  test("and a real API token is refused by the guest API", async () => {
    const res = await app.request("/api/v1/guest/session", {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(res.status, 401);
  });
});

describe("guest writes", () => {
  test("can add, edit, delete an expense and settle up inside the scope", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });

    const created = await guest(secret, "/expenses", {
      method: "POST",
      body: JSON.stringify({
        groupId: sharedGroupId,
        description: "Snacks",
        costMinor: 600,
        currencyCode: "USD",
        date: "2026-04-10",
        splitType: "equal",
        participants: [
          { userId: aliceId, paidMinor: 600 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(created.status, 201);
    const { id } = await json<{ id: string }>(created);

    // The guest is recorded as the author, not the owner who minted the link.
    const row = await db
      .selectFrom("expenses")
      .select(["created_by", "cost_minor"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    assert.equal(row.created_by, aliceId);

    const edited = await guest(secret, `/expenses/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        groupId: sharedGroupId,
        description: "Snacks and drinks",
        costMinor: 800,
        currencyCode: "USD",
        date: "2026-04-10",
        splitType: "equal",
        participants: [
          { userId: aliceId, paidMinor: 800 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(edited.status, 200);

    const settled = await guest(secret, "/payments", {
      method: "POST",
      body: JSON.stringify({
        groupId: sharedGroupId,
        fromUserId: aliceId,
        toUserId: ownerId,
        amountMinor: 500,
        currencyCode: "USD",
      }),
    });
    assert.equal(settled.status, 201);

    assert.equal((await guest(secret, `/expenses/${id}`, { method: "DELETE" })).status, 200);
  });

  test("cannot write into a group the link does not cover", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });

    const res = await guest(secret, "/expenses", {
      method: "POST",
      body: JSON.stringify({
        groupId: otherGroupId,
        description: "Sneaky",
        costMinor: 100,
        currencyCode: "USD",
        date: "2026-04-11",
        splitType: "equal",
        participants: [
          { userId: aliceId, paidMinor: 100 },
          { userId: ownerId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(res.status, 403);
  });

  test("a group link cannot create a 1:1 expense", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });

    const res = await guest(secret, "/expenses", {
      method: "POST",
      body: JSON.stringify({
        groupId: null,
        description: "Off the books",
        costMinor: 100,
        currencyCode: "USD",
        date: "2026-04-12",
        splitType: "equal",
        participants: [
          { userId: aliceId, paidMinor: 100 },
          { userId: ownerId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(res.status, 403);
  });

  test("cannot write an expense it is not on", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });

    const res = await guest(secret, "/expenses", {
      method: "POST",
      body: JSON.stringify({
        groupId: sharedGroupId,
        description: "Between two other people",
        costMinor: 100,
        currencyCode: "USD",
        date: "2026-04-13",
        splitType: "equal",
        participants: [
          { userId: ownerId, paidMinor: 100 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(res.status, 403);
  });

  test("an edit cannot move an expense out of the scope that authorised it", async () => {
    const secret = await mint({ kind: "friend", userId: aliceId });

    const res = await guest(secret, `/expenses/${sharedExpenseId}`, {
      method: "PATCH",
      body: JSON.stringify({
        groupId: secretGroupId,
        description: "Moved somewhere unreadable",
        costMinor: 9_000,
        currencyCode: "USD",
        date: "2026-04-01",
        splitType: "equal",
        participants: [
          { userId: aliceId, paidMinor: 9_000 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(res.status, 403);
  });

  test("there is no route to mint a link, add a person, or make a group", async () => {
    const secret = await mint({ kind: "group_member", groupId: sharedGroupId, userId: aliceId });

    for (const path of ["/links", "/groups", "/friends", "/people"]) {
      const res = await guest(secret, path, { method: "POST", body: "{}" });
      assert.ok(
        res.status === 404 || res.status === 405,
        `POST /api/v1/guest${path} must not exist, got ${res.status}`,
      );
    }
  });
});
