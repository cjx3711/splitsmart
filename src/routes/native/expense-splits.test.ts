/**
 * Every split type, through the real routes.
 *
 * split.test.ts already pins the arithmetic. What this covers is the plumbing
 * either side of it, which is where a split type gets half-added:
 *
 *   - the route accepts the type at all (the Zod enum and the DB CHECK both
 *     have to know about it, and they are in different files)
 *   - `items` reaches the split engine, and only for itemized
 *   - split_meta is persisted for itemized and NULL for everything else
 *   - editing an expense to a different split type CLEARS the old line items
 *   - the shares that land in expense_users still sum to the cost
 *
 * src/db/index.ts opens its connection at import time, so DATABASE_PATH is set
 * before the first dynamic import below, same pattern as import.test.ts.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-splits-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { updateExpense } = await import("../../domain/expenses.ts");
const { metadataFromSplitwise } = await import("../../domain/metadata.ts");
const { isUlid, ulid } = await import("../../domain/ulid.ts");

let apiToken: string;
let groupId: string;
const userIds: string[] = [];

async function post(path: string, body: unknown) {
  const res = await app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function patch(path: string, body: unknown) {
  const res = await app.request(`/api/v1${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function get(path: string) {
  const res = await app.request(`/api/v1${path}`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** The stored expense plus its shares, which is what every assertion here reads. */
async function stored(expenseId: string) {
  const expense = await db
    .selectFrom("expenses")
    .select(["cost_minor", "split_type", "split_meta"])
    .where("id", "=", expenseId)
    .executeTakeFirstOrThrow();

  const shares = await db
    .selectFrom("expense_users")
    .select(["user_id", "paid_share_minor", "owed_share_minor", "split_input"])
    .where("expense_id", "=", expenseId)
    .execute();

  // ULIDs minted in the same millisecond do not sort in insertion order.
  // Tests assert per-person amounts in Alice, Bob, Carol sequence.
  shares.sort((a, b) => userIds.indexOf(a.user_id) - userIds.indexOf(b.user_id));

  return { expense, shares, owed: shares.map((s) => s.owed_share_minor) };
}

/** Three people, one payer, 3000 JPY: a total that does not divide by three. */
function body(extra: Record<string, unknown>) {
  return {
    description: "Dinner",
    costMinor: 3000,
    currencyCode: "JPY",
    date: "2026-08-17",
    ...extra,
  };
}

/** The payer fronts the whole cost; `input` carries the per-type figure. */
function participants(inputs?: number[]) {
  return userIds.map((userId, i) => ({
    userId,
    paidMinor: i === 0 ? 3000 : 0,
    ...(inputs ? { input: inputs[i] } : {}),
  }));
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  for (const name of ["Alice", "Bob", "Carol"]) {
    const id = ulid();
    await db
      .insertInto("users")
      .values({
        id,
        email: `${name.toLowerCase()}@example.com`,
        password_hash: "scrypt$131072$8$1$AAAA$AAAA",
        name,
        default_currency: "JPY",
        is_ghost: 0,
      })
      .execute();
    userIds.push(id);
  }

  groupId = ulid();
  await db
    .insertInto("groups")
    .values({
      id: groupId,
      name: "Kyushu",
      group_type: "trip",
      default_currency: "JPY",
      created_by: userIds[0]!,
    })
    .execute();

  for (const id of userIds) {
    await db
      .insertInto("group_members")
      .values({ group_id: groupId, user_id: id, role: id === userIds[0] ? "owner" : "member" })
      .execute();
  }

  apiToken = (await createApiToken(userIds[0]!, "test")).token;
});

after(async () => {
  await db.destroy();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("split types over the native API", () => {
  test("equal", async () => {
    const { status, body: res } = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "equal", participants: participants() }));
    assert.equal(status, 201);

    const { expense, owed } = await stored(res.id);
    assert.ok(isUlid(res.id));
    assert.deepEqual(owed, [1000, 1000, 1000]);
    assert.equal(expense.split_meta, null);
  });

  test("exact", async () => {
    const { status, body: res } = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "exact", participants: participants([1500, 1000, 500]) }));
    assert.equal(status, 201);

    const { owed, shares } = await stored(res.id);
    assert.deepEqual(owed, [1500, 1000, 500]);
    // The raw figure is kept so the editor can reopen the same numbers.
    assert.deepEqual(shares.map((s) => s.split_input), [1500, 1000, 500]);
  });

  test("percent", async () => {
    const { status, body: res } = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "percent", participants: participants([50, 25, 25]) }));
    assert.equal(status, 201);
    assert.deepEqual((await stored(res.id)).owed, [1500, 750, 750]);
  });

  test("percent that does not total 100 is rejected", async () => {
    const { status } = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "percent", participants: participants([50, 25, 10]) }));
    assert.equal(status, 400);
  });

  test("shares", async () => {
    // 2:1:1 of 3000; the odd unit goes to the largest remainder.
    const { status, body: res } = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "shares", participants: participants([2, 1, 1]) }));
    assert.equal(status, 201);

    const { owed } = await stored(res.id);
    assert.deepEqual(owed, [1500, 750, 750]);
    assert.equal(owed.reduce((a, b) => a + b, 0), 3000);
  });

  test("adjustment gives one person their extra, then splits the rest evenly", async () => {
    // Alice had a 300 drink of her own: 2700 splits three ways, plus her 300.
    const { status, body: res } = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "adjustment", participants: participants([300, 0, 0]) }));
    assert.equal(status, 201);
    assert.deepEqual((await stored(res.id)).owed, [1200, 900, 900]);
  });

  test("an adjustment that drives someone negative is rejected", async () => {
    // expense_users has CHECK (owed_share_minor >= 0); this must fail in the
    // engine with a readable message rather than as a constraint violation.
    const { status } = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "adjustment", participants: participants([-2000, 0, 0]) }));
    assert.equal(status, 400);
  });

  test("itemized charges each line to its sharers and spreads the rest", async () => {
    const { status, body: res } = await post(`/groups/${groupId}/expenses`,
      body({
        splitType: "itemized",
        participants: participants(),
        items: [
          { label: "Wagyu", amountMinor: 1800, participantIds: [userIds[0]!, userIds[1]!] },
        ],
      }));
    assert.equal(status, 201);

    const { expense, owed } = await stored(res.id);
    // 900 each on the wagyu; the 1200 left over follows those weights, so
    // Carol (who ordered nothing) owes nothing.
    assert.deepEqual(owed, [1500, 1500, 0]);
    assert.equal(owed.reduce((a, b) => a + b, 0), 3000);

    assert.equal(expense.split_type, "itemized");
    assert.deepEqual(JSON.parse(expense.split_meta!), {
      items: [{ label: "Wagyu", amountMinor: 1800, participantIds: [userIds[0], userIds[1]] }],
    });
  });

  test("itemized without items is rejected", async () => {
    const { status } = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "itemized", participants: participants() }));
    assert.equal(status, 400);
  });

  test("items on a non-itemized split are rejected", async () => {
    // Otherwise they would be silently dropped, and the split would quietly be
    // something other than what was asked for.
    const { status } = await post(`/groups/${groupId}/expenses`,
      body({
        splitType: "equal",
        participants: participants(),
        items: [{ amountMinor: 3000, participantIds: [userIds[0]!] }],
      }));
    assert.equal(status, 400);
  });

  test("a line charged to someone outside the expense is rejected", async () => {
    const { status } = await post(`/groups/${groupId}/expenses`,
      body({
        splitType: "itemized",
        participants: [{ userId: userIds[0]!, paidMinor: 3000 }],
        items: [{ amountMinor: 3000, participantIds: [userIds[1]!] }],
      }));
    assert.equal(status, 400);
  });

  test("an unknown split type is rejected", async () => {
    const { status } = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "vibes", participants: participants() }));
    assert.equal(status, 400);
  });

  test("editing an itemized expense to another split type clears its line items", async () => {
    // The DB has CHECK (split_meta IS NULL OR split_type = 'itemized'), so a
    // stale blob is not merely untidy; the write would fail outright.
    const { body: res } = await post(`/groups/${groupId}/expenses`,
      body({
        splitType: "itemized",
        participants: participants(),
        items: [{ label: "Wagyu", amountMinor: 1800, participantIds: [userIds[0]!, userIds[1]!] }],
      }));
    assert.notEqual((await stored(res.id)).expense.split_meta, null);

    await updateExpense(res.id, {
      groupId,
      description: "Dinner",
      costMinor: 3000,
      currencyCode: "JPY",
      date: "2026-08-17",
      splitType: "equal",
      participants: participants(),
      updatedBy: userIds[0]!,
    });

    const after = await stored(res.id);
    assert.equal(after.expense.split_meta, null);
    assert.equal(after.expense.split_type, "equal");
    assert.deepEqual(after.owed, [1000, 1000, 1000]);
  });

  test("several people can each have fronted part of the cost", async () => {
    // The engine has always taken paidMinor per person; what this pins is that
    // the route does too, so "two people paid" is not silently collapsed into
    // one payer somewhere between the form and the ledger.
    const { status, body: res } = await post(`/groups/${groupId}/expenses`,
      body({
        splitType: "equal",
        participants: [
          { userId: userIds[0]!, paidMinor: 2000 },
          { userId: userIds[1]!, paidMinor: 1000 },
          { userId: userIds[2]!, paidMinor: 0 },
        ],
      }));
    assert.equal(status, 201);

    const { shares, owed } = await stored(res.id);
    assert.deepEqual(shares.map((s) => s.paid_share_minor), [2000, 1000, 0]);
    assert.deepEqual(owed, [1000, 1000, 1000]);

    // Alice is up 1000 and Bob is square, so only Carol owes, to Alice.
    const repayments = await db
      .selectFrom("expense_repayments")
      .select(["from_user_id", "to_user_id", "amount_minor"])
      .where("expense_id", "=", res.id)
      .execute();
    assert.deepEqual(repayments, [
      { from_user_id: userIds[2], to_user_id: userIds[0], amount_minor: 1000 },
    ]);
  });

  test("payments that do not add up to the cost are rejected", async () => {
    const { status } = await post(`/groups/${groupId}/expenses`,
      body({
        splitType: "equal",
        participants: [
          { userId: userIds[0]!, paidMinor: 2000 },
          { userId: userIds[1]!, paidMinor: 500 },
          { userId: userIds[2]!, paidMinor: 0 },
        ],
      }));
    assert.equal(status, 400);
  });

  test("tax and tip are stored alongside the lines they belong to", async () => {
    // 2600 of food, 100 tax, 300 tip: 3000 in all. The engine spreads the 400
    // in proportion to what each person ordered; the two figures name that gap.
    const { status, body: res } = await post(`/groups/${groupId}/expenses`,
      body({
        splitType: "itemized",
        participants: participants(),
        items: [
          { label: "Ramen", amountMinor: 1300, participantIds: [userIds[0]!] },
          { label: "Wine", amountMinor: 1300, participantIds: [userIds[1]!, userIds[2]!] },
        ],
        taxMinor: 100,
        tipMinor: 300,
      }));
    assert.equal(status, 201);

    const { expense, owed } = await stored(res.id);
    // Alice ordered half the food, so she carries half the tax and tip.
    assert.deepEqual(owed, [1500, 750, 750]);
    assert.equal(owed.reduce((a, b) => a + b, 0), 3000);

    const meta = JSON.parse(expense.split_meta!);
    assert.equal(meta.taxMinor, 100);
    assert.equal(meta.tipMinor, 300);
    assert.equal(meta.items.length, 2);
  });

  test("a tax and tip that disagree with the lines are rejected", async () => {
    // Storing them anyway would leave a caption contradicting the ledger.
    const { status } = await post(`/groups/${groupId}/expenses`,
      body({
        splitType: "itemized",
        participants: participants(),
        items: [{ label: "Ramen", amountMinor: 2000, participantIds: userIds }],
        taxMinor: 100,
        tipMinor: 100,
      }));
    assert.equal(status, 400);
  });

  test("tax and tip on a non-itemized split are rejected", async () => {
    const { status } = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "equal", participants: participants(), taxMinor: 100 }));
    assert.equal(status, 400);
  });
});

describe("POST /expenses: the generic endpoint", () => {
  test("creates a non-group expense between three people", async () => {
    // Neither of the older endpoints can express this: /groups/:id needs a
    // group, and /friends/:id caps the expense at the two of you.
    const { status, body: res } = await post("/expenses",
      body({
        splitType: "equal",
        participants: userIds.map((userId, i) => ({ userId, paidMinor: i === 0 ? 3000 : 0 })),
      }));
    assert.equal(status, 201);

    const expense = await db
      .selectFrom("expenses")
      .select(["group_id", "details"])
      .where("id", "=", res.id)
      .executeTakeFirstOrThrow();
    assert.equal(expense.group_id, null);
    assert.deepEqual((await stored(res.id)).owed, [1000, 1000, 1000]);
  });

  test("puts the expense in a group when one is named", async () => {
    const { status, body: res } = await post("/expenses",
      body({
        groupId,
        details: "Split after the ferry",
        splitType: "equal",
        participants: userIds.map((userId, i) => ({ userId, paidMinor: i === 0 ? 3000 : 0 })),
      }));
    assert.equal(status, 201);

    const expense = await db
      .selectFrom("expenses")
      .select(["group_id", "details"])
      .where("id", "=", res.id)
      .executeTakeFirstOrThrow();
    assert.equal(expense.group_id, groupId);
    assert.equal(expense.details, "Split after the ferry");
  });

  test("refuses a non-group expense the caller is not on", async () => {
    // A non-group expense between two other people creates a balance neither of
    // them can see and this app has no screen for.
    const { status } = await post("/expenses",
      body({
        splitType: "equal",
        participants: [
          { userId: userIds[1]!, paidMinor: 3000 },
          { userId: userIds[2]!, paidMinor: 0 },
        ],
      }));
    assert.equal(status, 400);
  });

  test("a group member can manage an expense they are not on", async () => {
    // Converting remaining debts records payments between other members.
    const created = await post(
      "/expenses",
      body({
        groupId,
        description: "Balance conversion",
        splitType: "exact",
        participants: [
          { userId: userIds[1]!, paidMinor: 3000, input: 0 },
          { userId: userIds[2]!, paidMinor: 0, input: 3000 },
        ],
      }),
    );
    assert.equal(created.status, 201);
    const id = created.body.id as string;

    const got = await app.request(`/api/v1/expenses/${id}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(got.status, 200);

    const patched = await app.request(`/api/v1/expenses/${id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(
        body({
          groupId,
          description: "Balance conversion",
          details: "quoted rate",
          splitType: "exact",
          participants: [
            { userId: userIds[1]!, paidMinor: 3000, input: 0 },
            { userId: userIds[2]!, paidMinor: 0, input: 3000 },
          ],
        }),
      ),
    });
    assert.equal(patched.status, 200);

    const deleted = await app.request(`/api/v1/expenses/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(deleted.status, 200);

    const restored = await app.request(`/api/v1/expenses/${id}/restore`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(restored.status, 200);
  });

  test("refuses a stranger on a non-group expense", async () => {
    const strangerId = ulid();
    await db
      .insertInto("users")
      .values({
        id: strangerId,
        email: "dave@example.com",
        password_hash: "scrypt$131072$8$1$AAAA$AAAA",
        name: "Dave",
        default_currency: "JPY",
        is_ghost: 0,
      })
      .execute();

    const { status, body: res } = await post("/expenses",
      body({
        splitType: "equal",
        participants: [
          { userId: userIds[0]!, paidMinor: 3000 },
          { userId: strangerId, paidMinor: 0 },
        ],
      }));
    assert.equal(status, 400);
    assert.match(res.error, /share history/);
  });

  test("refuses a group the caller is not a member of", async () => {
    const otherId = ulid();
    await db
      .insertInto("groups")
      .values({
        id: otherId,
        name: "Someone else's trip",
        group_type: "trip",
        default_currency: "JPY",
        created_by: userIds[1]!,
      })
      .execute();

    const { status } = await post("/expenses",
      body({
        groupId: otherId,
        splitType: "equal",
        participants: [{ userId: userIds[0]!, paidMinor: 3000 }],
      }));
    assert.equal(status, 403);
  });
});

describe("client-minted expense ids", () => {
  test("stores the supplied ULID as the primary key", async () => {
    const id = ulid();
    const { status, body: res } = await post(`/groups/${groupId}/expenses`,
      body({ id, splitType: "equal", participants: participants() }));
    assert.equal(status, 201);
    assert.equal(res.id, id);
    assert.ok(isUlid(res.id));
  });

  test("a retry with the same id is a no-op that returns the existing row", async () => {
    const id = ulid();
    const first = await post(`/groups/${groupId}/expenses`,
      body({ id, description: "Original", splitType: "equal", participants: participants() }));
    assert.equal(first.status, 201);

    const retry = await post(`/groups/${groupId}/expenses`,
      body({
        id,
        description: "Should not overwrite",
        costMinor: 9999,
        splitType: "equal",
        participants: participants(),
      }));
    assert.equal(retry.status, 201);
    assert.equal(retry.body.id, id);

    const row = await db
      .selectFrom("expenses")
      .select(["description", "cost_minor"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    assert.equal(row.description, "Original");
    assert.equal(row.cost_minor, 3000);
  });

  test("rejects an invalid id before writing", async () => {
    const { status } = await post(`/groups/${groupId}/expenses`,
      body({ id: "not-a-ulid", splitType: "equal", participants: participants() }));
    assert.equal(status, 400);
  });

  test("an invalid path id is 400, not a silent miss", async () => {
    const res = await app.request("/api/v1/expenses/not-a-ulid", {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(res.status, 400);
  });
});

describe("extra metadata", () => {
  test("extra survives a PATCH that omits it", async () => {
    const created = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "equal", participants: participants(), extra: { note: "toolkit" } }));
    assert.equal(created.status, 201);
    const id = created.body.id as string;
    assert.deepEqual((await get(`/expenses/${id}`)).body.expense.extra, { note: "toolkit" });

    const patched = await patch(`/expenses/${id}`,
      body({ splitType: "equal", participants: participants(), description: "Dinner (edited)" }));
    assert.equal(patched.status, 200);

    const got = await get(`/expenses/${id}`);
    assert.equal(got.body.expense.description, "Dinner (edited)");
    assert.deepEqual(got.body.expense.extra, { note: "toolkit" });
  });

  test("a PATCH with extra preserves splitwise_id and a paused series' interval", async () => {
    const created = await post(`/groups/${groupId}/expenses`,
      body({ splitType: "equal", participants: participants(), repeatInterval: "monthly" }));
    assert.equal(created.status, 201);
    const id = created.body.id as string;

    // Stamp splitwise_id the way the importer would - not reachable over the API.
    await db.updateTable("expenses")
      .set({ metadata: metadataFromSplitwise(998877, "confirmed") })
      .where("id", "=", id)
      .execute();

    // Stop the series: metadata.repeat_paused becomes "monthly".
    const stopped = await patch(`/expenses/${id}`,
      body({ splitType: "equal", participants: participants(), repeatInterval: null }));
    assert.equal(stopped.status, 200);

    const beforeExtra = await get(`/expenses/${id}`);
    assert.equal(beforeExtra.body.expense.repeat_paused, "monthly");
    assert.equal(beforeExtra.body.expense.splitwise_id, 998877);

    // Writing `extra` (repeatInterval absent, meaning "leave the schedule
    // alone") must not disturb either.
    const withExtra = await patch(`/expenses/${id}`,
      body({ splitType: "equal", participants: participants(), extra: { synced: true } }));
    assert.equal(withExtra.status, 200);

    const final = await get(`/expenses/${id}`);
    assert.deepEqual(final.body.expense.extra, { synced: true });
    assert.equal(final.body.expense.repeat_paused, "monthly");
    assert.equal(final.body.expense.splitwise_id, 998877);
  });

  test("an over-cap extra payload is rejected", async () => {
    const { status } = await post(`/groups/${groupId}/expenses`,
      body({
        splitType: "equal",
        participants: participants(),
        extra: { blob: "x".repeat(4200) },
      }));
    assert.equal(status, 400);
  });

  test("a reserved key inside extra cannot reach the real metadata key", async () => {
    const created = await post(`/groups/${groupId}/expenses`,
      body({
        splitType: "equal",
        participants: participants(),
        extra: { splitwise_id: 999, repeat_paused: "weekly" },
      }));
    assert.equal(created.status, 201);
    const id = created.body.id as string;

    const got = await get(`/expenses/${id}`);
    assert.equal(got.body.expense.splitwise_id, null);
    assert.equal(got.body.expense.repeat_paused, null);
    assert.deepEqual(got.body.expense.extra, { splitwise_id: 999, repeat_paused: "weekly" });
  });
});

describe("the ledger after all of the above", () => {
  test("every expense written here still satisfies the paid/owed invariant", async () => {
    // The same check `yarn db:check` runs, scoped to this test's writes: a
    // split type that balanced in the engine but was persisted wrong would slip
    // past every assertion above.
    const rows = await db
      .selectFrom("expenses")
      .innerJoin("expense_users", "expense_users.expense_id", "expenses.id")
      .select(({ fn, ref }) => [
        "expenses.id",
        "expenses.cost_minor",
        fn.sum<number>(ref("expense_users.paid_share_minor")).as("paid"),
        fn.sum<number>(ref("expense_users.owed_share_minor")).as("owed"),
      ])
      .where("expenses.deleted_at", "is", null)
      .groupBy(["expenses.id", "expenses.cost_minor"])
      .execute();

    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.equal(Number(row.paid), row.cost_minor, `expense ${row.id} paid shares`);
      assert.equal(Number(row.owed), row.cost_minor, `expense ${row.id} owed shares`);
    }
  });
});
