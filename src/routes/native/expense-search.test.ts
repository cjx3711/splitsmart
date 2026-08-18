/**
 * Search, filters, CSV, and restore.
 *
 * The filter tests are mostly about scope: a filter narrows what a caller can
 * already see and must never widen it. The one that would matter in the wild is
 * `group_id` on the group endpoint - if that replaced the group scope instead of
 * adding to it, `GET /groups/A/expenses?group_id=B` would be a data leak.
 *
 * The CSV tests pin the format that anybody's spreadsheet import mapping would
 * depend on, plus the guest download being link-scoped rather than owner-scoped.
 *
 * Restore is here because it is the other half of delete: the tombstone has been
 * stored since day one and until now there was no way back. What matters is that
 * balances return to where they were, which means repayments have to be rebuilt.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-search-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense } = await import("../../domain/expenses.ts");
const { getBalanceBetween } = await import("../../domain/balances.ts");
const { mintAccessLink } = await import("../../domain/access-links.ts");
const { ulid } = await import("../../domain/ulid.ts");

let aliceId: string;
let bobId: string;
let carolId: string;
let ghostId: string;
let flatId: string;
let tripId: string;
let aliceToken: string;
let guestSecret: string;

/** ids, so assertions can name expenses rather than matching on strings twice. */
const ids: Record<string, string> = {};

async function person(name: string, email?: string): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({
      id,
      ...(email
        ? { email, password_hash: "scrypt$131072$8$1$AAAA$AAAA", is_ghost: 0 }
        : { is_ghost: 1 }),
      name,
      default_currency: "USD",
    })
    .execute();
  return id;
}

async function group(name: string, members: string[]): Promise<string> {
  const id = ulid();
  await db
    .insertInto("groups")
    .values({ id, name, default_currency: "USD", created_by: aliceId })
    .execute();
  for (const userId of members) {
    await db
      .insertInto("group_members")
      .values({
        group_id: id,
        user_id: userId,
        role: userId === aliceId ? "owner" : "member",
        joined_via: "added",
      })
      .execute();
  }
  return id;
}

async function get(path: string, token = aliceToken) {
  const res = await app.request(`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function text(path: string, token = aliceToken) {
  const res = await app.request(`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

/** Descriptions of the rows a list endpoint returned, for compact assertions. */
function names(body: any): string[] {
  return (body.expenses as Array<{ description: string }>).map((e) => e.description).sort();
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  aliceId = await person("Alice", "alice@example.com");
  bobId = await person("Bob", "bob@example.com");
  carolId = await person("Carol", "carol@example.com");
  ghostId = await person("Ghost");

  flatId = await group("Flat", [aliceId, bobId, ghostId]);
  tripId = await group("Trip", [aliceId, carolId]);

  aliceToken = (await createApiToken(aliceId, "test")).token;
  guestSecret = (
    await mintAccessLink(db, {
      kind: "group_member",
      groupId: flatId,
      userId: ghostId,
      createdBy: aliceId,
    })
  ).secret;

  const make = async (
    key: string,
    input: Parameters<typeof createExpense>[0],
  ): Promise<void> => {
    ids[key] = await createExpense(input);
  };

  await make("rent", {
    groupId: flatId,
    description: "Rent for March",
    costMinor: 100_000,
    currencyCode: "USD",
    date: "2026-03-01",
    // Splitwise's "Rent". A real leaf id, so the category filter is exercised
    // against the same numbers the importer would carry.
    categoryId: 3,
    splitType: "equal",
    participants: [
      { userId: aliceId, paidMinor: 100_000 },
      { userId: bobId, paidMinor: 0 },
    ],
    createdBy: aliceId,
  });

  await make("dinner", {
    groupId: flatId,
    description: "Dinner out, 50% mine",
    costMinor: 6000,
    currencyCode: "USD",
    date: "2026-04-15",
    categoryId: 13,
    splitType: "equal",
    participants: [
      { userId: aliceId, paidMinor: 6000 },
      { userId: bobId, paidMinor: 0 },
    ],
    createdBy: aliceId,
  });

  await make("flights", {
    groupId: tripId,
    description: "Flights",
    costMinor: 40_000,
    currencyCode: "USD",
    date: "2026-05-01",
    splitType: "equal",
    participants: [
      { userId: aliceId, paidMinor: 40_000 },
      { userId: carolId, paidMinor: 0 },
    ],
    createdBy: aliceId,
  });

  await make("coffee", {
    groupId: null,
    description: "Coffee",
    costMinor: 900,
    currencyCode: "USD",
    date: "2026-04-20",
    splitType: "equal",
    participants: [
      { userId: aliceId, paidMinor: 900 },
      { userId: bobId, paidMinor: 0 },
    ],
    createdBy: aliceId,
  });

  await make("settle", {
    groupId: flatId,
    description: "Payment",
    costMinor: 5000,
    currencyCode: "USD",
    date: "2026-04-21",
    splitType: "exact",
    isPayment: true,
    participants: [
      { userId: bobId, paidMinor: 5000, input: 0 },
      { userId: aliceId, paidMinor: 0, input: 5000 },
    ],
    createdBy: aliceId,
  });

  // The ghost's own bill, so the guest CSV has something in scope.
  await make("milk", {
    groupId: flatId,
    description: "Milk",
    costMinor: 400,
    currencyCode: "USD",
    date: "2026-04-22",
    splitType: "equal",
    participants: [
      { userId: ghostId, paidMinor: 400 },
      { userId: aliceId, paidMinor: 0 },
    ],
    createdBy: aliceId,
  });
});

after(async () => {
  await db.destroy();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("searching descriptions", () => {
  test("matches a case-insensitive substring", async () => {
    assert.deepEqual(names((await get("/expenses?q=rent")).body), ["Rent for March"]);
    assert.deepEqual(names((await get("/expenses?q=DINNER")).body), ["Dinner out, 50% mine"]);
  });

  test("treats % and _ as characters, not wildcards", async () => {
    // A LIKE-based search would return everything for "%". This one finds the
    // one description that actually contains a percent sign.
    assert.deepEqual(names((await get("/expenses?q=50%25")).body), ["Dinner out, 50% mine"]);
    assert.deepEqual(names((await get("/expenses?q=%25")).body), ["Dinner out, 50% mine"]);
    assert.deepEqual(names((await get("/expenses?q=_")).body), []);
  });

  test("an unmatched search is empty, not everything", async () => {
    assert.deepEqual(names((await get("/expenses?q=zzzz")).body), []);
  });
});

describe("filters", () => {
  test("by group, and by no group at all", async () => {
    assert.deepEqual(names((await get(`/expenses?group_id=${tripId}`)).body), ["Flights"]);
    assert.deepEqual(names((await get("/expenses?group_id=none")).body), ["Coffee"]);
  });

  test("by date range, inclusive of the closing day", async () => {
    // The stored date is a full timestamp; a naive string compare on the upper
    // bound would drop everything dated on the last day.
    assert.deepEqual(
      names((await get("/expenses?dated_after=2026-04-15&dated_before=2026-04-20")).body),
      ["Coffee", "Dinner out, 50% mine"],
    );
    assert.deepEqual(names((await get("/expenses?dated_before=2026-03-01")).body), [
      "Rent for March",
    ]);
  });

  test("by category", async () => {
    assert.deepEqual(names((await get("/expenses?category_id=13")).body), [
      "Dinner out, 50% mine",
    ]);
  });

  test("by kind: settle-ups are expenses too, until you say otherwise", async () => {
    assert.deepEqual(names((await get("/expenses?is_payment=true")).body), ["Payment"]);
    assert.ok(!names((await get("/expenses?is_payment=false")).body).includes("Payment"));
  });

  test("by person: only bills you share with them", async () => {
    assert.deepEqual(names((await get(`/expenses?friend_id=${carolId}`)).body), ["Flights"]);
  });

  test("combine, and they narrow together", async () => {
    assert.deepEqual(
      names((await get(`/expenses?group_id=${flatId}&is_payment=false&q=rent`)).body),
      ["Rent for March"],
    );
  });

  test("junk is ignored rather than rejected", async () => {
    // A stale bookmark should show your expenses, not an error.
    const res = await get("/expenses?category_id=not-a-number&group_id=nope&dated_after=soon");
    assert.equal(res.status, 200);
    assert.ok(res.body.expenses.length > 0);
  });
});

describe("scope beats filters", () => {
  test("a group_id filter cannot pull another group into a group listing", async () => {
    const res = await get(`/groups/${flatId}/expenses?group_id=${tripId}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.expenses, [], "narrowed to nothing, never widened to Trip");
  });

  test("a friend listing still only shows bills you share", async () => {
    const res = await get(`/friends/${bobId}/expenses?q=flights`);
    assert.deepEqual(names(res.body), [], "Flights is Alice and Carol; Bob cannot see it here");
  });

  test("filters on the group listing still work normally", async () => {
    const res = await get(`/groups/${flatId}/expenses?q=rent`);
    assert.deepEqual(names(res.body), ["Rent for March"]);
  });
});

describe("CSV", () => {
  test("header, quoting, and per-currency decimal places", async () => {
    const res = await text("/expenses.csv?q=rent");

    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename=/);

    const lines = res.body.trim().split("\n");
    assert.equal(
      lines[0],
      "date,description,category,group,currency,cost,is_payment,paid_by,owed_by,notes,comments,repeats",
    );
    assert.equal(lines.length, 2);
    // Money as a decimal string, with the currency in its own column so the
    // number is never ambiguous.
    assert.match(lines[1]!, /^2026-03-01,Rent for March,/);
    assert.match(lines[1]!, /,USD,1000\.00,no,/);
    // Who paid and who owed, as two fields. Semicolon-separated on purpose: a
    // comma would force quoting on every multi-person bill for no benefit.
    assert.match(lines[1]!, /,Alice: 1000\.00,Alice: 500\.00; Bob: 500\.00,/);
  });

  test("a zero-decimal currency is not divided by 100", async () => {
    const jpy = await createExpense({
      groupId: null,
      description: "Ramen",
      costMinor: 3400,
      currencyCode: "JPY",
      date: "2026-06-01",
      splitType: "equal",
      participants: [{ userId: aliceId, paidMinor: 3400 }],
      createdBy: aliceId,
    });
    assert.ok(jpy);

    const res = await text("/expenses.csv?q=ramen");
    assert.match(res.body, /,JPY,3400,no,/);
  });

  test("a quote in a description is doubled, not dropped", async () => {
    await createExpense({
      groupId: null,
      description: 'The "Best" Cafe, downtown',
      costMinor: 100,
      currencyCode: "USD",
      date: "2026-06-02",
      splitType: "equal",
      participants: [{ userId: aliceId, paidMinor: 100 }],
      createdBy: aliceId,
    });

    const res = await text("/expenses.csv?q=Best");
    assert.match(res.body, /"The ""Best"" Cafe, downtown"/);
  });

  test("only what the caller can see", async () => {
    const bobToken = (await createApiToken(bobId, "csv")).token;
    const res = await text("/expenses.csv", bobToken);
    assert.ok(!res.body.includes("Flights"), "Bob is not on the Trip expenses");
    assert.ok(res.body.includes("Rent for March"));
  });

  test("it needs authentication, and a guest link is not it", async () => {
    assert.equal((await app.request("/api/v1/expenses.csv")).status, 401);

    const withLink = await app.request("/api/v1/expenses.csv", {
      headers: { Authorization: `Bearer link_${guestSecret}` },
    });
    assert.equal(withLink.status, 401, "a link_ token never reaches /api/v1 proper");
  });

  test("the guest download is scoped to the link, not to the owner", async () => {
    const res = await app.request("/api/v1/guest/expenses.csv", {
      headers: { Authorization: `Bearer link_${guestSecret}` },
    });
    assert.equal(res.status, 200);
    const body = await res.text();

    assert.ok(body.includes("Milk"), "the ghost's own bill is in scope");
    assert.ok(!body.includes("Flights"), "another group is not");
    assert.ok(!body.includes("Coffee"), "and neither is a 1:1 expense of the owner's");
  });

  test("an empty result is still a valid file with its header", async () => {
    const res = await text("/expenses.csv?q=definitely-nothing");
    assert.equal(res.body.trim().split("\n").length, 1);
  });
});

describe("restore", () => {
  test("balances come back, and the repayment cache is rebuilt", async () => {
    const target = await createExpense({
      groupId: flatId,
      description: "Restorable",
      costMinor: 2000,
      currencyCode: "USD",
      date: "2026-07-01",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 2000 },
        { userId: bobId, paidMinor: 0 },
      ],
      createdBy: aliceId,
    });

    const before = await getBalanceBetween(db, aliceId, bobId);

    await app.request(`/api/v1/expenses/${target}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    const during = await getBalanceBetween(db, aliceId, bobId);
    assert.notDeepEqual(during, before, "a deleted expense stops counting");

    const restored = await app.request(`/api/v1/expenses/${target}/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    assert.equal(restored.status, 200);

    assert.deepEqual(await getBalanceBetween(db, aliceId, bobId), before);

    // The cache is a derivation of expense_users, so it must exist and agree.
    const repayments = await db
      .selectFrom("expense_repayments")
      .select(["from_user_id", "to_user_id", "amount_minor"])
      .where("expense_id", "=", target)
      .execute();
    assert.deepEqual(repayments, [
      { from_user_id: bobId, to_user_id: aliceId, amount_minor: 1000 },
    ]);
  });

  test("the expense is readable again, and the feed records both events", async () => {
    const target = await createExpense({
      groupId: flatId,
      description: "Round trip",
      costMinor: 1000,
      currencyCode: "USD",
      date: "2026-07-02",
      splitType: "equal",
      participants: [{ userId: aliceId, paidMinor: 1000 }],
      createdBy: aliceId,
    });

    await app.request(`/api/v1/expenses/${target}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    assert.equal((await get(`/expenses/${target}`)).status, 404, "a tombstone is not readable");

    await app.request(`/api/v1/expenses/${target}/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${aliceToken}` },
    });
    assert.equal((await get(`/expenses/${target}`)).status, 200);

    const actions = await db
      .selectFrom("activity")
      .select("action")
      .where("expense_id", "=", target)
      .execute();
    assert.ok(actions.some((a) => a.action === "expense.deleted"));
    assert.ok(actions.some((a) => a.action === "expense.restored"));
  });

  test("restoring twice is a no-op, not an error", async () => {
    const target = await createExpense({
      groupId: flatId,
      description: "Twice restored",
      costMinor: 1000,
      currencyCode: "USD",
      date: "2026-07-03",
      splitType: "equal",
      participants: [{ userId: aliceId, paidMinor: 1000 }],
      createdBy: aliceId,
    });

    await app.request(`/api/v1/expenses/${target}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${aliceToken}` },
    });

    for (const _ of [1, 2]) {
      const res = await app.request(`/api/v1/expenses/${target}/restore`, {
        method: "POST",
        headers: { Authorization: `Bearer ${aliceToken}` },
      });
      assert.equal(res.status, 200);
    }
  });

  test("only a participant may restore", async () => {
    const target = await createExpense({
      groupId: tripId,
      description: "Not Bob's",
      costMinor: 1000,
      currencyCode: "USD",
      date: "2026-07-04",
      splitType: "equal",
      participants: [
        { userId: aliceId, paidMinor: 1000 },
        { userId: carolId, paidMinor: 0 },
      ],
      createdBy: aliceId,
    });

    await app.request(`/api/v1/expenses/${target}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${aliceToken}` },
    });

    const bobToken = (await createApiToken(bobId, "restore")).token;
    const res = await app.request(`/api/v1/expenses/${target}/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bobToken}` },
    });
    assert.equal(res.status, 404);
  });
});
