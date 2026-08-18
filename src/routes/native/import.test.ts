/**
 * Splitwise import, end to end against a fake Splitwise.
 *
 * The fake is a real HTTP server on an ephemeral port, and the importer reaches
 * it through SPLITWISE_API_BASE, the same knob an agent would use to drive the
 * wizard without a Splitwise account. Nothing is mocked at the module level, so
 * what this exercises is the actual client, the actual routes, and the actual
 * expense writer.
 *
 * The properties that matter here are the ones that ruin a ledger quietly:
 *
 *   - people are matched on email, and the preview says who was matched
 *   - Splitwise's own owed_share allocation survives the trip, cent for cent
 *   - group 0 ("Non-group expenses") becomes a NULL group, not a group named 0
 *   - a second run imports nothing and duplicates nothing
 *   - a bad row is skipped with a reason, and never half-written
 *
 * The port is not known until the fake is listening, and src/db/index.ts opens
 * its connection at import time, so both the port and DATABASE_PATH are fixed
 * before the first dynamic import below.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const API_KEY = "test-splitwise-key-123456";
const ME_SW_ID = 1000;

// --- the fake Splitwise -----------------------------------------------------

const swFriends = [
  // Matches an existing SplitSmart account by email; the heuristic under test.
  { id: 2001, first_name: "Bob", last_name: "Brown", email: "bob@example.com" },
  // No local account: becomes a placeholder.
  { id: 2002, first_name: "Carol", last_name: "Clark", email: "carol@example.com", created_at: "2021-04-01T00:00:00Z" },
];

const swGroups = [
  // Splitwise always includes this pseudo-group. It is not a group.
  { id: 0, name: "Non-group expenses", members: [] },
  {
    id: 3001,
    name: "Flat",
    group_type: "apartment",
    simplify_by_default: true,
    created_at: "2019-06-01T00:00:00Z",
    members: [
      { id: ME_SW_ID, first_name: "Alice", last_name: "Anderson", email: "alice@example.com" },
      ...swFriends,
    ],
  },
];

/**
 * Comments, in BOTH shapes Splitwise might hand them over in.
 *
 * 4001 carries them nested on the expense list (no extra request needed); 4002
 * only reports a count, so the paged /import/comments step has to go and fetch
 * them. The importer supports both because the fixture that would settle which
 * one the real API sends can only be captured against a live account. See
 * docs/PARITY.md, "Capture what import will need".
 */
const swComments: Record<number, unknown[]> = {
  4001: [
    {
      id: 9001,
      content: "I paid this one in cash",
      comment_type: "User",
      created_at: "2026-03-02T16:00:00Z",
      user: { id: 2001, first_name: "Bob", last_name: "Brown", email: "bob@example.com" },
    },
    {
      // The edit history Splitwise generates. The only version of it we can ever
      // have, which is why System rows are imported rather than dropped.
      id: 9002,
      content: "Alice updated this transaction: - The cost changed from $900.00 to $1000.00",
      comment_type: "System",
      created_at: "2026-03-02T16:05:00Z",
      user: { id: ME_SW_ID, first_name: "Alice", last_name: "Anderson", email: "alice@example.com" },
    },
  ],
  4002: [
    {
      // An author nobody has seen yet: becomes a placeholder rather than costing
      // us the comment.
      id: 9003,
      content: "Was this the place by the station?",
      comment_type: "User",
      created_at: "2026-03-03T09:00:00Z",
      user: { id: 2003, first_name: "Dave", last_name: "Doe", email: "dave@example.com" },
    },
    {
      // Deleted at the source: skipped, exactly like a deleted expense.
      id: 9004,
      content: "never mind",
      comment_type: "User",
      created_at: "2026-03-03T09:05:00Z",
      deleted_at: "2026-03-03T09:06:00Z",
      user: { id: 2001, first_name: "Bob", last_name: "Brown", email: "bob@example.com" },
    },
  ],
};

const swExpenses = [
  {
    id: 4001,
    group_id: 3001,
    description: "Rent",
    cost: "1000.00",
    currency_code: "USD",
    date: "2026-03-01T00:00:00Z",
    created_at: "2026-03-02T15:30:00Z",
    category: { id: 13, name: "Dining out" },
    // Nested, and a count that agrees with the array.
    comments_count: 2,
    comments: swComments[4001],
    // A recurring series in Splitwise. Imported as the bill that happened, never
    // as a live template: originating future copies is not importing.
    repeats: true,
    repeat_interval: "monthly",
    next_repeat: "2026-04-01T00:00:00Z",
    // Receipts are never imported. One preview warning, not a skip per expense.
    receipt: { original: "https://splitwise.example/receipt.jpg", large: null },
    users: [
      { user: swGroups[1]!.members[0], paid_share: "1000.00", owed_share: "333.34" },
      { user: swFriends[0], paid_share: "0.00", owed_share: "333.33" },
      { user: swFriends[1], paid_share: "0.00", owed_share: "333.33" },
    ],
  },
  {
    // Non-group, and a zero-decimal currency: 3400 JPY is 3400 minor units.
    id: 4002,
    group_id: 0,
    description: "Ramen",
    cost: "3400",
    currency_code: "JPY",
    date: "2026-03-02T00:00:00Z",
    // A count with no nested array: this is the shape that needs step 4.
    comments_count: 2,
    users: [
      { user: swGroups[1]!.members[0], paid_share: "3400", owed_share: "1700" },
      { user: swFriends[0], paid_share: "0", owed_share: "1700" },
    ],
  },
  {
    // A settle-up. Must land as is_payment = 1.
    id: 4003,
    group_id: 3001,
    description: "Payment",
    payment: true,
    cost: "50.00",
    currency_code: "USD",
    date: "2026-03-03T00:00:00Z",
    users: [
      { user: swFriends[0], paid_share: "50.00", owed_share: "0.00" },
      { user: swGroups[1]!.members[0], paid_share: "0.00", owed_share: "50.00" },
    ],
  },
  {
    // Tombstone: skipped, because importing it would mean writing a row purely
    // to soft-delete it.
    id: 4004,
    group_id: 3001,
    description: "Cancelled",
    cost: "10.00",
    currency_code: "USD",
    date: "2026-03-04T00:00:00Z",
    deleted_at: "2026-03-05T00:00:00Z",
    users: [{ user: swFriends[0], paid_share: "10.00", owed_share: "10.00" }],
  },
  {
    // Not a real ISO 4217 code, so `currency_code` has no foreign key to point
    // at. Skipped with a reason rather than coerced into USD.
    id: 4005,
    group_id: 3001,
    description: "Mystery money",
    cost: "5.00",
    currency_code: "ZZZ",
    date: "2026-03-06T00:00:00Z",
    users: [{ user: swFriends[0], paid_share: "5.00", owed_share: "5.00" }],
  },
];

/** Requests the fake saw, so auth and paging can be asserted on. */
const seen: Array<{ path: string; auth: string | undefined }> = [];

function startFakeSplitwise(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seen.push({ path: url.pathname, auth: req.headers.authorization });

    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      return send(401, { error: "Invalid API request: you are not logged in" });
    }

    switch (url.pathname) {
      case "/api/v3.0/get_current_user":
        return send(200, {
          user: {
            id: ME_SW_ID,
            first_name: "Alice",
            last_name: "Anderson",
            email: "alice@example.com",
            default_currency: "USD",
          },
        });
      case "/api/v3.0/get_friends":
        return send(200, { friends: swFriends });
      case "/api/v3.0/get_groups":
        return send(200, { groups: swGroups });
      case "/api/v3.0/get_comments": {
        const expenseId = Number(url.searchParams.get("expense_id"));
        return send(200, { comments: swComments[expenseId] ?? [] });
      }
      case "/api/v3.0/get_expenses": {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        return send(200, { expenses: swExpenses.slice(offset, offset + limit) });
      }
      default:
        return send(404, { error: "not found" });
    }
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}/api/v3.0` });
    });
  });
}

// --- boot -------------------------------------------------------------------

const fake = await startFakeSplitwise();

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-import-test-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";
process.env.SPLITWISE_API_BASE = fake.base;

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { ulid, isUlid, ulidTime } = await import("../../domain/ulid.ts");
const { splitwiseIdOf, splitwiseIdSql } = await import("../../domain/metadata.ts");

let apiToken: string;
let aliceId: string;
let bobId: string;

async function post(path: string, body: unknown, token = apiToken) {
  const res = await app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Edits an expense the way a person would, so a re-import can see local work. */
async function patchExpense(expenseId: string, description: string) {
  const current = await db
    .selectFrom("expenses")
    .select(["cost_minor", "currency_code", "date", "group_id", "is_payment"])
    .where("id", "=", expenseId)
    .executeTakeFirstOrThrow();
  const shares = await db
    .selectFrom("expense_users")
    .select(["user_id", "paid_share_minor", "owed_share_minor"])
    .where("expense_id", "=", expenseId)
    .execute();

  const res = await app.request(`/api/v1/expenses/${expenseId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      groupId: current.group_id,
      description,
      costMinor: current.cost_minor,
      currencyCode: current.currency_code,
      date: current.date,
      splitType: "exact",
      participants: shares.map((s) => ({
        userId: s.user_id,
        paidMinor: s.paid_share_minor,
        input: s.owed_share_minor,
      })),
    }),
  });
  if (res.status !== 200) throw new Error(`patch failed: ${res.status} ${await res.text()}`);
}

async function get(path: string, token = apiToken) {
  const res = await app.request(`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json()) as any };
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
    })
    .execute();

  // Bob already has a real SplitSmart account at the address Splitwise knows
  // him by. He must be matched, not duplicated.
  bobId = ulid();
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

  apiToken = (await createApiToken(aliceId, "test")).token;
});

after(async () => {
  await db.destroy();
  fake.server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("import status", () => {
  test("reports an empty account and states the matching rule", async () => {
    const { status, body } = await get("/import/status");
    assert.equal(status, 200);
    assert.equal(body.hasData, false);
    assert.equal(body.local.expenses, 0);
    assert.match(body.matchingRule, /matched .* by email address/i);
  });

  test("requires authentication", async () => {
    const res = await app.request("/api/v1/import/status");
    assert.equal(res.status, 401);
  });
});

describe("preview", () => {
  test("rejects a bad key with 400, not 502", async () => {
    const { status, body } = await post("/import/preview", { apiKey: "wrong-key-abcdef" });
    assert.equal(status, 400);
    assert.match(body.error, /rejected that API key/i);
  });

  test("names who will be matched by email and writes nothing", async () => {
    const { status, body } = await post("/import/preview", { apiKey: API_KEY });
    assert.equal(status, 200);

    assert.equal(body.splitwiseAccount.id, ME_SW_ID);
    // Group 0 is not a group.
    assert.equal(body.counts.groups, 1);
    assert.equal(body.counts.friends, 2);
    assert.equal(body.counts.expenses, swExpenses.length);

    const bob = body.people.find((p: any) => p.email === "bob@example.com");
    const carol = body.people.find((p: any) => p.email === "carol@example.com");
    assert.equal(bob.matchedBy, "email");
    assert.equal(bob.localUserId, bobId);
    assert.equal(carol.matchedBy, "created");
    assert.equal(carol.localUserId, null, "preview must not mint an id for someone it has not created");

    assert.ok(
      body.warnings.some((w: string) => w.includes("Bob Brown") && /email address/i.test(w)),
      "the email-matching warning should name the people it applies to",
    );

    // A preview that writes is not a preview.
    const users = await db.selectFrom("users").select("id").execute();
    assert.equal(users.length, 2);
  });

  test("does not warn about existing data when there is none", async () => {
    const { body } = await post("/import/preview", { apiKey: API_KEY });
    assert.ok(!body.warnings.some((w: string) => /already has/i.test(w)));
  });
});

describe("friends", () => {
  test("matches Bob, creates Carol, and makes both explicit friends", async () => {
    const { status, body } = await post("/import/friends", { apiKey: API_KEY });
    assert.equal(status, 200);
    assert.equal(body.matched, 1);
    assert.equal(body.created, 1);

    const carol = body.people.find((p: any) => p.email === "carol@example.com");
    assert.equal(carol.matchedBy, "created");
    assert.ok(isUlid(carol.localUserId));
    // No guest link is minted by an import. Bringing your history across is
    // not deciding to share it with the people in it. See docs/GUEST.md.
    const links = await db
      .selectFrom("access_links")
      .select("id")
      .where("user_id", "=", carol.localUserId)
      .execute();
    assert.deepEqual(links, []);

    const carolRow = await db
      .selectFrom("users")
      .select(["id", "metadata", "created_at"])
      .where("id", "=", carol.localUserId)
      .executeTakeFirstOrThrow();
    assert.equal(splitwiseIdOf(carolRow.metadata), 2002);
    assert.ok(isUlid(carolRow.id));
    assert.equal(ulidTime(carolRow.id), Date.parse("2021-04-01T00:00:00Z"));
    assert.equal(Date.parse(carolRow.created_at), Date.parse("2021-04-01T00:00:00Z"));

    const friends = await get("/friends");
    const names = friends.body.friends.map((f: any) => f.name).sort();
    assert.deepEqual(names, ["Bob Brown", "Carol Clark"]);
    assert.ok(friends.body.friends.every((f: any) => f.is_explicit));

    // Bob is still Bob: no duplicate row, and no ghost shadowing his account.
    const bobs = await db.selectFrom("users").select("id").where("email", "=", "bob@example.com").execute();
    assert.equal(bobs.length, 1);
    const bobRow = await db
      .selectFrom("users")
      .select(["metadata", "is_ghost"])
      .where("id", "=", bobId)
      .executeTakeFirstOrThrow();
    assert.equal(splitwiseIdOf(bobRow.metadata), 2001);
    assert.equal(bobRow.is_ghost, 0, "matching must not demote a real account to a ghost");
  });

  test("a later preview warns that the account is no longer empty", async () => {
    const { body } = await post("/import/preview", { apiKey: API_KEY });
    assert.ok(
      body.warnings.some((w: string) => /already has/i.test(w)),
      "friends now exist, so the wizard must warn before adding more",
    );
  });

  test("is idempotent", async () => {
    const second = await post("/import/friends", { apiKey: API_KEY });
    assert.equal(second.body.created, 0);
    assert.equal(second.body.matched, 2);

    const users = await db.selectFrom("users").select("id").execute();
    assert.equal(users.length, 3, "Alice, Bob, Carol, and nobody else");
  });
});

describe("groups", () => {
  test("imports Flat, skips group 0, and maps apartment to home", async () => {
    const { status, body } = await post("/import/groups", { apiKey: API_KEY });
    assert.equal(status, 200);
    assert.equal(body.groups.length, 1);
    assert.equal(body.groups[0].name, "Flat");
    assert.equal(body.groups[0].created, true);

    const group = await db
      .selectFrom("groups")
      .selectAll()
      .where(splitwiseIdSql(), "=", 3001)
      .executeTakeFirstOrThrow();
    assert.ok(isUlid(group.id));
    assert.equal(ulidTime(group.id), Date.parse("2019-06-01T00:00:00Z"));
    assert.equal(Date.parse(group.created_at), Date.parse("2019-06-01T00:00:00Z"));
    assert.equal(splitwiseIdOf(group.metadata), 3001);
    assert.equal(group.group_type, "home");
    assert.equal(group.simplify_by_default, 1);

    const members = await db
      .selectFrom("group_members")
      .select(["user_id", "role"])
      .where("group_id", "=", group.id)
      .execute();
    assert.equal(members.length, 3);
    assert.equal(members.find((m) => m.user_id === aliceId)?.role, "owner");
  });

  test("re-running matches instead of creating a second Flat", async () => {
    const { body } = await post("/import/groups", { apiKey: API_KEY });
    assert.equal(body.groups[0].created, false);
    assert.equal(body.groups[0].membersAdded, 0);

    const groups = await db.selectFrom("groups").select("id").execute();
    assert.equal(groups.length, 1);
  });
});

describe("expenses", () => {
  test("imports a page, preserving Splitwise's own share allocation", async () => {
    const { status, body } = await post("/import/expenses", { apiKey: API_KEY });
    assert.equal(status, 200);
    assert.equal(body.fetched, swExpenses.length);
    assert.equal(body.imported, 3);
    assert.equal(body.done, false, "a full page always offers a next offset");

    const rent = await db
      .selectFrom("expenses")
      .selectAll()
      .where(splitwiseIdSql(), "=", 4001)
      .executeTakeFirstOrThrow();
    assert.ok(isUlid(rent.id));
    assert.equal(ulidTime(rent.id), Date.parse("2026-03-02T15:30:00Z"), "ULID time is created_at, not date");
    assert.equal(Date.parse(rent.created_at), Date.parse("2026-03-02T15:30:00Z"));
    assert.equal(splitwiseIdOf(rent.metadata), 4001);
    assert.equal(rent.cost_minor, 100_000);
    assert.equal(rent.currency_code, "USD");
    assert.equal(rent.category_id, 13);
    assert.equal(rent.split_type, "exact");

    // 333.34 / 333.33 / 333.33: Splitwise's rounding, not ours. Re-deriving an
    // equal split here would move a cent and therefore move a balance.
    const shares = await db
      .selectFrom("expense_users")
      .select(["user_id", "paid_share_minor", "owed_share_minor"])
      .where("expense_id", "=", rent.id)
      .orderBy("owed_share_minor", "desc")
      .execute();
    assert.deepEqual(
      shares.map((s) => s.owed_share_minor),
      [33_334, 33_333, 33_333],
    );
    assert.equal(shares.reduce((sum, s) => sum + s.owed_share_minor, 0), rent.cost_minor);
    assert.equal(shares.find((s) => s.user_id === aliceId)?.paid_share_minor, 100_000);
  });

  test("group 0 becomes a NULL group, and JPY keeps zero decimals", async () => {
    const ramen = await db
      .selectFrom("expenses")
      .selectAll()
      .where(splitwiseIdSql(), "=", 4002)
      .executeTakeFirstOrThrow();
    assert.equal(ramen.group_id, null, "Splitwise group 0 is not a group");
    assert.equal(ramen.currency_code, "JPY");
    assert.equal(ramen.cost_minor, 3400, "3400 JPY is 3400 minor units, not 340000");
    assert.equal(ulidTime(ramen.id), Date.parse("2026-03-02T00:00:00Z"), "without created_at, ULID time is the expense date");
    assert.equal(Date.parse(ramen.created_at), Date.parse("2026-03-02T00:00:00Z"));
  });

  test("a settle-up lands as a payment", async () => {
    const payment = await db
      .selectFrom("expenses")
      .selectAll()
      .where(splitwiseIdSql(), "=", 4003)
      .executeTakeFirstOrThrow();
    assert.equal(payment.is_payment, 1);
  });

  test("skips the unimportable with a reason, and writes nothing for them", async () => {
    const { body } = await post("/import/expenses", { apiKey: API_KEY, offset: 0 });
    const reasons = new Map(body.skipped.map((s: any) => [s.splitwiseId, s.reason]));

    assert.match(String(reasons.get(4004)), /deleted in splitwise/i);
    assert.match(String(reasons.get(4005)), /unknown currency ZZZ/i);

    for (const id of [4004, 4005]) {
      const row = await db
        .selectFrom("expenses")
        .select("id")
        .where(splitwiseIdSql(), "=", id)
        .executeTakeFirst();
      assert.equal(row, undefined, `expense ${id} must not be half-written`);
    }
  });

  test("re-running a page imports nothing and duplicates nothing", async () => {
    const { body } = await post("/import/expenses", { apiKey: API_KEY, offset: 0 });
    assert.equal(body.imported, 0);
    assert.equal(body.alreadyPresent, 3);

    const count = await db.selectFrom("expenses").select("id").execute();
    assert.equal(count.length, 3);
  });

  test("paging walks to the end", async () => {
    const first = await post("/import/expenses", { apiKey: API_KEY, offset: 0, limit: 2 });
    assert.equal(first.body.fetched, 2);
    assert.equal(first.body.nextOffset, 2);

    const last = await post("/import/expenses", {
      apiKey: API_KEY,
      offset: swExpenses.length,
      limit: 2,
    });
    assert.equal(last.body.fetched, 0);
    assert.equal(last.body.done, true);
    assert.equal(last.body.nextOffset, null);
  });

  test("the feed gets one import entry, not one per expense", async () => {
    const activity = await db
      .selectFrom("activity")
      .select(["action"])
      .where("action", "like", "expense.%")
      .execute();
    assert.equal(activity.length, 0, "imported expenses must not flood the activity feed");

    const imports = await db
      .selectFrom("activity")
      .select("id")
      .where("action", "=", "import.completed")
      .execute();
    assert.ok(imports.length >= 1);
  });
});

describe("comments", () => {
  test("nested comments come in with their expense, User and System alike", async () => {
    const rent = await db
      .selectFrom("expenses")
      .select(["id", "metadata"])
      .where(splitwiseIdSql(), "=", 4001)
      .executeTakeFirstOrThrow();

    const comments = await db
      .selectFrom("comments")
      .select(["id", "kind", "content", "user_id", "metadata", "created_at"])
      .where("expense_id", "=", rent.id)
      .orderBy("created_at")
      .execute();

    assert.equal(comments.length, 2);
    assert.equal(comments[0]!.kind, "user");
    assert.equal(comments[0]!.user_id, bobId, "authored by the person Splitwise says wrote it");
    assert.equal(splitwiseIdOf(comments[0]!.metadata), 9001);
    assert.ok(isUlid(comments[0]!.id));
    assert.equal(
      ulidTime(comments[0]!.id),
      Date.parse("2026-03-02T16:00:00Z"),
      "the ULID carries the original instant, so a thread sorts as it was written",
    );

    // Splitwise's own edit history, kept as a system row: not deletable, and not
    // written by any HTTP route.
    assert.equal(comments[1]!.kind, "system");
    assert.match(comments[1]!.content, /The cost changed from/);
  });

  test("an imported comment is not a feed event", async () => {
    const events = await db
      .selectFrom("activity")
      .select("id")
      .where("action", "like", "comment.%")
      .execute();
    assert.deepEqual(events, [], "one summary entry per run, not one per comment");
  });

  test("the paged step fetches the comments Splitwise did not nest", async () => {
    const { status, body } = await post("/import/comments", { apiKey: API_KEY });
    assert.equal(status, 200);
    assert.equal(body.imported, 1, "one live comment on the Ramen expense");

    const ramen = await db
      .selectFrom("expenses")
      .select("id")
      .where(splitwiseIdSql(), "=", 4002)
      .executeTakeFirstOrThrow();

    const comments = await db
      .selectFrom("comments")
      .select(["content", "user_id", "metadata"])
      .where("expense_id", "=", ramen.id)
      .execute();

    assert.equal(comments.length, 1, "the source-deleted one was skipped, not imported");
    assert.equal(splitwiseIdOf(comments[0]!.metadata), 9003);

    // An author nobody had seen became a placeholder rather than being dropped.
    const dave = await db
      .selectFrom("users")
      .select(["id", "name", "is_ghost"])
      .where("id", "=", comments[0]!.user_id)
      .executeTakeFirstOrThrow();
    assert.equal(dave.name, "Dave Doe");
    assert.equal(dave.is_ghost, 1);
  });

  test("running the comments step again fetches nothing and writes nothing", async () => {
    const before = await db.selectFrom("comments").select("id").execute();
    const requestsBefore = seen.filter((r) => r.path.endsWith("/get_comments")).length;

    const { body } = await post("/import/comments", { apiKey: API_KEY });
    assert.equal(body.imported, 0);
    assert.ok(body.alreadyPresent > 0, "already-synced expenses are skipped on their stamp");

    const after = await db.selectFrom("comments").select("id").execute();
    assert.equal(after.length, before.length);
    assert.equal(
      seen.filter((r) => r.path.endsWith("/get_comments")).length,
      requestsBefore,
      "a second run must not re-fetch every expense",
    );
  });

  test("an imported comment is visible on the expense it hangs off", async () => {
    const rent = await db
      .selectFrom("expenses")
      .select("id")
      .where(splitwiseIdSql(), "=", 4001)
      .executeTakeFirstOrThrow();

    const { status, body } = await get(`/expenses/${rent.id}/comments`);
    assert.equal(status, 200);
    assert.equal(body.comments.length, 2);
    assert.ok(body.comments.some((c: any) => c.kind === "system"));
  });
});

describe("recurrence and receipts", () => {
  test("a Splitwise recurring expense does NOT become a live template here", async () => {
    const rent = await db
      .selectFrom("expenses")
      .select(["repeat_interval", "next_repeat", "repeat_of"])
      .where(splitwiseIdSql(), "=", 4001)
      .executeTakeFirstOrThrow();

    // Splitwise says repeats: true, monthly, next 2026-04-01. Importing that as a
    // schedule would start generating bills this account never asked us to
    // originate. It arrives as the bill that already happened, and nothing else.
    assert.equal(rent.repeat_interval, null);
    assert.equal(rent.next_repeat, null);
    assert.equal(rent.repeat_of, null);
  });

  test("the preview says so, and says receipts are not imported", async () => {
    const { body } = await post("/import/preview", { apiKey: API_KEY });
    assert.ok(
      body.warnings.some((w: string) => /future repeats are not scheduled/i.test(w)),
      "a user must be told before, not discover it afterwards",
    );
    assert.ok(body.warnings.some((w: string) => /receipt images are not imported/i.test(w)));
    assert.ok(body.warnings.some((w: string) => /comments come across/i.test(w)));
    assert.ok(body.counts.comments >= 2, "the count is a floor from the first page");
  });
});

describe("balances after import", () => {
  test("agree with the imported shares", async () => {
    const { body } = await get("/friends");
    const bob = body.friends.find((f: any) => f.id === bobId);

    // Rent: Alice paid 1000.00, owes 333.34 -> Bob owes her 333.33.
    // Payment: Bob paid 50.00 to Alice -> Bob owes 283.33.
    // Ramen: Alice paid 3400 JPY, Bob owes 1700 JPY.
    const usd = bob.balances.find((b: any) => b.currencyCode === "USD");
    const jpy = bob.balances.find((b: any) => b.currencyCode === "JPY");
    assert.equal(usd.amountMinor, 28_333);
    assert.equal(jpy.amountMinor, 1700, "currencies are never converted, so JPY stands alone");
  });
});

describe("run", () => {
  test("does the whole thing in one call and reports completion", async () => {
    const { status, body } = await post("/import/run", { apiKey: API_KEY });
    assert.equal(status, 200);
    assert.equal(body.expenses.complete, true);
    assert.equal(body.expenses.nextOffset, null);
    // Everything already landed in the step-by-step tests above.
    assert.equal(body.expenses.imported, 0);
    assert.equal(body.expenses.alreadyPresent, 3);
    assert.equal(body.groups.groups[0].created, false);
  });

  test("never sends the key anywhere but Splitwise, and always sends it there", async () => {
    assert.ok(seen.length > 0);
    assert.ok(
      seen.every((r) => r.path.startsWith("/api/v3.0/")),
      "the importer must only call documented Splitwise read endpoints",
    );
    assert.ok(seen.some((r) => r.auth === `Bearer ${API_KEY}`));
  });
});

describe("guests", () => {
  test("cannot import", async () => {
    const ghostId = ulid();
    await db
      .insertInto("users")
      .values({
        id: ghostId,
        name: "Ghost",
        is_ghost: 1,
        default_currency: "USD",
      })
      .execute();
    const ghostToken = (await createApiToken(ghostId, "ghost")).token;

    const { status } = await post("/import/preview", { apiKey: API_KEY }, ghostToken);
    assert.equal(status, 403);
  });
});

describe("re-import as update", () => {
  test("an upstream change lands when nothing has edited the local row", async () => {
    const before = await db
      .selectFrom("expenses")
      .select(["id", "created_at", "updated_at", "cost_minor", "metadata"])
      .where(splitwiseIdSql(), "=", 4003)
      .executeTakeFirstOrThrow();
    // "Untouched" is either never edited at all (updated_at == created_at, which
    // createExpense guarantees for an imported row) or last written by the
    // importer itself, which stamps splitwise_synced_at as it goes.
    assert.equal(
      before.updated_at === before.created_at ||
        before.updated_at === JSON.parse(before.metadata).splitwise_synced_at,
      true,
      "an imported row nobody has edited must still look untouched",
    );

    // Splitwise's copy changes.
    const payment = swExpenses.find((e) => e.id === 4003)! as any;
    payment.cost = "60.00";
    payment.users[0].paid_share = "60.00";
    payment.users[1].owed_share = "60.00";

    const { body } = await post("/import/expenses", { apiKey: API_KEY, offset: 0 });
    assert.equal(body.refreshed, 1);

    const after = await db
      .selectFrom("expenses")
      .select(["cost_minor", "updated_at", "created_at", "metadata"])
      .where(splitwiseIdSql(), "=", 4003)
      .executeTakeFirstOrThrow();
    assert.equal(after.cost_minor, 6000);

    // The refresh stamps itself, so the NEXT run can still tell an import from a
    // person having edited the bill here.
    const synced = JSON.parse(after.metadata).splitwise_synced_at;
    assert.equal(after.updated_at, synced);

    const shares = await db
      .selectFrom("expense_users")
      .select(["paid_share_minor", "owed_share_minor"])
      .where("expense_id", "=", before.id)
      .execute();
    assert.equal(shares.reduce((sum, s) => sum + s.owed_share_minor, 0), 6000);
  });

  test("a second refresh of the same row is a no-op, not a rewrite", async () => {
    const { body } = await post("/import/expenses", { apiKey: API_KEY, offset: 0 });
    assert.equal(body.refreshed, 0, "nothing changed upstream this time");
    assert.equal(body.alreadyPresent, 3);
  });

  test("a locally edited row is skipped with a reason, never overwritten", async () => {
    const local = await db
      .selectFrom("expenses")
      .select("id")
      .where(splitwiseIdSql(), "=", 4003)
      .executeTakeFirstOrThrow();

    // Somebody fixes the description here, the way a person would.
    await patchExpense(local.id, "Payment, by bank transfer");

    const payment = swExpenses.find((e) => e.id === 4003)! as any;
    payment.cost = "70.00";
    payment.users[0].paid_share = "70.00";
    payment.users[1].owed_share = "70.00";

    const { body } = await post("/import/expenses", { apiKey: API_KEY, offset: 0 });
    assert.equal(body.refreshed, 0);
    const skip = body.skipped.find((s: any) => s.splitwiseId === 4003);
    assert.match(String(skip.reason), /local edits, not refreshed/i);

    const after = await db
      .selectFrom("expenses")
      .select(["cost_minor", "description"])
      .where("id", "=", local.id)
      .executeTakeFirstOrThrow();
    assert.equal(after.cost_minor, 6000, "the local amount stands");
    assert.equal(after.description, "Payment, by bank transfer", "and so does the local wording");
  });

  test("local comments are never deleted by a re-import", async () => {
    const rent = await db
      .selectFrom("expenses")
      .select("id")
      .where(splitwiseIdSql(), "=", 4001)
      .executeTakeFirstOrThrow();

    await post(`/expenses/${rent.id}/comments`, { content: "Ours, not Splitwise's" });
    await post("/import/expenses", { apiKey: API_KEY, offset: 0 });
    await post("/import/comments", { apiKey: API_KEY });

    const mine = await db
      .selectFrom("comments")
      .select("id")
      .where("expense_id", "=", rent.id)
      .where("content", "=", "Ours, not Splitwise's")
      .execute();
    assert.equal(mine.length, 1, "Splitwise never saw it, so it is not Splitwise's to remove");
  });
});
