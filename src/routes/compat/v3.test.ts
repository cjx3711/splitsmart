/**
 * End-to-end test of the Splitwise-compatible API.
 *
 * Runs the real Hono app against a throwaway SQLite file and asserts on the
 * exact response SHAPES that splitwise-to-toshl consumes. These assertions are
 * intentionally about field names and string formats rather than business
 * logic: the whole point of the compat layer is that its wire format never
 * drifts, and a rename that "reads better" is a breaking change.
 *
 * DATABASE_PATH is set before importing anything that opens the database,
 * because src/db/index.ts opens a connection at module load.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-test-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

// Dynamic imports so the env vars above are in place first.
const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense } = await import("../../domain/expenses.ts");

let apiToken: string;
let aliceId: number;
let bobId: number;
let groupId: number;
let categoryId: number;

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

  // Bob is a ghost — no email, no password — exactly what the invite flow makes.
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

  const category = await db
    .selectFrom("categories")
    .select("id")
    .where("parent_id", "is not", null)
    .executeTakeFirstOrThrow();
  categoryId = category.id;

  // Alice pays 30.00, split evenly — Bob ends up owing her 15.00.
  await createExpense({
    groupId,
    description: "Dinner",
    costMinor: 3000,
    currencyCode: "USD",
    date: "2026-08-01",
    categoryId,
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

describe("compat: auth", () => {
  test("rejects requests with no token", async () => {
    const res = await app.request("/api/sw/v3.0/get_current_user");
    assert.equal(res.status, 401);
  });

  test("rejects a bogus token", async () => {
    const res = await app.request("/api/sw/v3.0/get_current_user", {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    assert.equal(res.status, 401);
  });

  test("is mounted at /api/sw/v3.0", async () => {
    const res = await authed("/api/sw/v3.0/get_current_user");
    assert.equal(res.status, 200);
  });
});

describe("compat: get_current_user", () => {
  test("returns the fields splitwise-to-toshl validates on", async () => {
    const res = await authed("/api/sw/v3.0/get_current_user");
    assert.equal(res.status, 200);

    const body = (await res.json()) as { user: Record<string, unknown> };
    // useAccounts.tsx rejects the account unless BOTH of these are truthy.
    assert.ok(body.user.id, "user.id must be truthy");
    assert.ok(body.user.email, "user.email must be truthy");
    assert.equal(body.user.first_name, "Alice");
    assert.equal(body.user.default_currency, "USD");
  });
});

describe("compat: get_friends", () => {
  test("returns friends with a per-currency balance array", async () => {
    const res = await authed("/api/sw/v3.0/get_friends");
    assert.equal(res.status, 200);

    const body = (await res.json()) as { friends: Array<Record<string, any>> };
    assert.equal(body.friends.length, 1);

    const bob = body.friends[0]!;
    assert.equal(bob.id, bobId);
    assert.equal(bob.first_name, "Bob");
    assert.ok(Array.isArray(bob.balance), "balance must be an array");
    assert.equal(bob.balance[0].currency_code, "USD");
    // Alice is owed 15.00 — as a decimal STRING, like Splitwise.
    assert.equal(bob.balance[0].amount, "15.00");
    assert.equal(typeof bob.balance[0].amount, "string");
  });

  test("gives ghosts a synthetic email so clients don't reject them", async () => {
    const res = await authed("/api/sw/v3.0/get_friends");
    const body = (await res.json()) as { friends: Array<Record<string, any>> };
    assert.ok(body.friends[0]!.email, "ghost email must be truthy");
    assert.match(body.friends[0]!.email, /@splitsmart\.invalid$/);
  });
});

describe("compat: get_friend/:id", () => {
  test("returns a single friend with the balance owed", async () => {
    const res = await authed(`/api/sw/v3.0/get_friend/${bobId}`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { friend: Record<string, any> };
    assert.equal(body.friend.id, bobId);
    assert.equal(body.friend.balance[0].amount, "15.00");
  });

  test("404s on an unknown friend", async () => {
    const res = await authed("/api/sw/v3.0/get_friend/99999");
    assert.equal(res.status, 404);
  });
});

describe("compat: get_categories", () => {
  test("nests subcategories under parents", async () => {
    const res = await authed("/api/sw/v3.0/get_categories");
    assert.equal(res.status, 200);

    const body = (await res.json()) as { categories: Array<Record<string, any>> };
    assert.ok(body.categories.length > 0);

    const parent = body.categories[0]!;
    assert.ok(parent.id);
    assert.ok(parent.name);
    // SplitwiseBulkAdd.tsx flattens parent.subcategories — the key must exist.
    assert.ok(Array.isArray(parent.subcategories));
    assert.ok(parent.subcategories.length > 0);
    assert.ok(parent.subcategories[0].id);
    assert.ok(parent.subcategories[0].name);
  });
});

describe("compat: get_expenses", () => {
  test("returns the exact field shape Friend.tsx reads", async () => {
    const res = await authed("/api/sw/v3.0/get_expenses?limit=10");
    assert.equal(res.status, 200);

    const body = (await res.json()) as { expenses: Array<Record<string, any>> };
    assert.equal(body.expenses.length, 1);

    const expense = body.expenses[0]!;
    assert.ok(expense.id);
    assert.equal(expense.description, "Dinner");
    assert.equal(expense.cost, "30.00");
    assert.equal(expense.currency_code, "USD");
    // Friend.tsx does e.date.split("T")[0] — a bare date would break it.
    assert.ok(expense.date.includes("T"), "date must be a full ISO timestamp");
    assert.equal(expense.date.split("T")[0], "2026-08-01");
    // Read as e.category.name, not a flat string.
    assert.equal(typeof expense.category, "object");
    assert.ok(expense.category.name);
    assert.equal(expense.deleted_at, null);
  });

  test("expense users carry both user_id and nested user.id", async () => {
    const res = await authed("/api/sw/v3.0/get_expenses?limit=10");
    const body = (await res.json()) as { expenses: Array<Record<string, any>> };
    const users = body.expenses[0]!.users;

    assert.equal(users.length, 2);
    for (const u of users) {
      // Friend.tsx reads eu.user.id AND eu.user_id on the same object.
      assert.ok(u.user_id);
      assert.ok(u.user.id);
      assert.equal(u.user_id, u.user.id);
      assert.equal(typeof u.paid_share, "string");
      assert.equal(typeof u.owed_share, "string");
    }

    const alice = users.find((u: any) => u.user_id === aliceId);
    assert.equal(alice.paid_share, "30.00");
    assert.equal(alice.owed_share, "15.00");
  });

  test("filters by friend_id", async () => {
    const mine = await authed(`/api/sw/v3.0/get_expenses?friend_id=${bobId}`);
    assert.equal(((await mine.json()) as any).expenses.length, 1);

    const none = await authed("/api/sw/v3.0/get_expenses?friend_id=99999");
    assert.equal(((await none.json()) as any).expenses.length, 0);
  });

  test("filters by date range", async () => {
    const inRange = await authed(
      "/api/sw/v3.0/get_expenses?dated_after=2026-07-01&dated_before=2026-08-31",
    );
    assert.equal(((await inRange.json()) as any).expenses.length, 1);

    const outOfRange = await authed(
      "/api/sw/v3.0/get_expenses?dated_after=2026-09-01&dated_before=2026-09-30",
    );
    assert.equal(((await outOfRange.json()) as any).expenses.length, 0);
  });

  test("honours limit and offset", async () => {
    const res = await authed("/api/sw/v3.0/get_expenses?limit=1&offset=5");
    assert.equal(((await res.json()) as any).expenses.length, 0);
  });
});

describe("compat: create_expense", () => {
  test("accepts Splitwise's flattened users__N__ body", async () => {
    const res = await authed("/api/sw/v3.0/create_expense", {
      method: "POST",
      body: JSON.stringify({
        cost: "20.00",
        description: "Taxi",
        date: "2026-08-05T00:00:00Z",
        currency_code: "USD",
        category_id: categoryId,
        group_id: groupId,
        users__0__user_id: aliceId,
        users__0__paid_share: "20.00",
        users__0__owed_share: "10.00",
        users__1__user_id: bobId,
        users__1__paid_share: "0.00",
        users__1__owed_share: "10.00",
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as { expenses: any[]; errors: unknown };
    assert.equal(body.expenses.length, 1);
    assert.equal(body.expenses[0].description, "Taxi");
    assert.equal(body.expenses[0].cost, "20.00");
    assert.deepEqual(body.errors, {});
  });

  test("the new expense moves the balance", async () => {
    // Alice was owed 15.00; the taxi adds another 10.00.
    const res = await authed(`/api/sw/v3.0/get_friend/${bobId}`);
    const body = (await res.json()) as { friend: Record<string, any> };
    assert.equal(body.friend.balance[0].amount, "25.00");
  });

  test("rejects shares that don't add up, with an errors object", async () => {
    const res = await authed("/api/sw/v3.0/create_expense", {
      method: "POST",
      body: JSON.stringify({
        cost: "20.00",
        description: "Broken",
        date: "2026-08-05T00:00:00Z",
        currency_code: "USD",
        group_id: groupId,
        users__0__user_id: aliceId,
        users__0__paid_share: "20.00",
        users__0__owed_share: "5.00", // 5 + 10 != 20
        users__1__user_id: bobId,
        users__1__paid_share: "0.00",
        users__1__owed_share: "10.00",
      }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as { errors: Record<string, string[]> };
    assert.ok(body.errors.base?.length);
  });

  test("rejects a non-member participant", async () => {
    const outsider = await db
      .insertInto("users")
      .values({ first_name: "Outsider", default_currency: "USD", is_ghost: 1 })
      .returning("id")
      .executeTakeFirstOrThrow();

    const res = await authed("/api/sw/v3.0/create_expense", {
      method: "POST",
      body: JSON.stringify({
        cost: "10.00",
        description: "Sneaky",
        date: "2026-08-05T00:00:00Z",
        currency_code: "USD",
        group_id: groupId,
        users__0__user_id: aliceId,
        users__0__paid_share: "10.00",
        users__0__owed_share: "5.00",
        users__1__user_id: outsider.id,
        users__1__paid_share: "0.00",
        users__1__owed_share: "5.00",
      }),
    });

    assert.equal(res.status, 400);
  });
});

describe("compat: zero-decimal currencies", () => {
  test("JPY amounts have no decimal point", async () => {
    const jpyExpense = await createExpense({
      groupId,
      description: "Ramen",
      costMinor: 3000, // 3000 JPY, not 30.00
      currencyCode: "JPY",
      date: "2026-08-10",
      splitType: "equal",
      createdBy: aliceId,
      participants: [
        { userId: aliceId, paidMinor: 3000 },
        { userId: bobId, paidMinor: 0 },
      ],
    });
    assert.ok(jpyExpense);

    const res = await authed("/api/sw/v3.0/get_expenses?limit=50");
    const body = (await res.json()) as { expenses: Array<Record<string, any>> };
    const ramen = body.expenses.find((e) => e.description === "Ramen");

    assert.ok(ramen);
    assert.equal(ramen.cost, "3000", "JPY must not gain decimal places");
  });

  test("balances stay in separate per-currency buckets", async () => {
    const res = await authed(`/api/sw/v3.0/get_friend/${bobId}`);
    const body = (await res.json()) as { friend: Record<string, any> };

    const codes = body.friend.balance.map((b: any) => b.currency_code).sort();
    assert.deepEqual(codes, ["JPY", "USD"]);

    const jpy = body.friend.balance.find((b: any) => b.currency_code === "JPY");
    assert.equal(jpy.amount, "1500");
  });
});
