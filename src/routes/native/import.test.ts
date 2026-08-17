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
  { id: 2002, first_name: "Carol", last_name: "Clark", email: "carol@example.com" },
];

const swGroups = [
  // Splitwise always includes this pseudo-group. It is not a group.
  { id: 0, name: "Non-group expenses", members: [] },
  {
    id: 3001,
    name: "Flat",
    group_type: "apartment",
    simplify_by_default: true,
    members: [
      { id: ME_SW_ID, first_name: "Alice", last_name: "Anderson", email: "alice@example.com" },
      ...swFriends,
    ],
  },
];

const swExpenses = [
  {
    id: 4001,
    group_id: 3001,
    description: "Rent",
    cost: "1000.00",
    currency_code: "USD",
    date: "2026-03-01T00:00:00Z",
    category: { id: 13, name: "Dining out" },
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

let apiToken: string;
let aliceId: number;
let bobId: number;

async function post(path: string, body: unknown, token = apiToken) {
  const res = await app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
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

  // Bob already has a real SplitSmart account at the address Splitwise knows
  // him by. He must be matched, not duplicated.
  const bob = await db
    .insertInto("users")
    .values({
      email: "bob@example.com",
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      first_name: "Bob",
      last_name: "Brown",
      default_currency: "USD",
      is_ghost: 0,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  bobId = bob.id;

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
    // Same contract as POST /friends: shown once, or never again.
    assert.match(carol.recoveryCode, /\S/);

    const friends = await get("/friends");
    const names = friends.body.friends.map((f: any) => f.first_name).sort();
    assert.deepEqual(names, ["Bob", "Carol"]);
    assert.ok(friends.body.friends.every((f: any) => f.is_explicit));

    // Bob is still Bob: no duplicate row, and no ghost shadowing his account.
    const bobs = await db.selectFrom("users").select("id").where("email", "=", "bob@example.com").execute();
    assert.equal(bobs.length, 1);
    const bobRow = await db
      .selectFrom("users")
      .select(["splitwise_id", "is_ghost"])
      .where("id", "=", bobId)
      .executeTakeFirstOrThrow();
    assert.equal(bobRow.splitwise_id, 2001);
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
      .where("splitwise_id", "=", 3001)
      .executeTakeFirstOrThrow();
    assert.equal(group.group_type, "home");
    assert.equal(group.simplify_by_default, 1);
    assert.equal(group.invite_token, null, "an imported group is not shared until you share it");

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
      .where("splitwise_id", "=", 4001)
      .executeTakeFirstOrThrow();
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
      .where("splitwise_id", "=", 4002)
      .executeTakeFirstOrThrow();
    assert.equal(ramen.group_id, null, "Splitwise group 0 is not a group");
    assert.equal(ramen.currency_code, "JPY");
    assert.equal(ramen.cost_minor, 3400, "3400 JPY is 3400 minor units, not 340000");
  });

  test("a settle-up lands as a payment", async () => {
    const payment = await db
      .selectFrom("expenses")
      .selectAll()
      .where("splitwise_id", "=", 4003)
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
        .where("splitwise_id", "=", id)
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
    const ghost = await db
      .insertInto("users")
      .values({ first_name: "Ghost", is_ghost: 1, default_currency: "USD" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const ghostToken = (await createApiToken(ghost.id, "ghost")).token;

    const { status } = await post("/import/preview", { apiKey: API_KEY }, ghostToken);
    assert.equal(status, 403);
  });
});
