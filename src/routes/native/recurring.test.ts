/**
 * Recurring expenses, end to end: the routes, the writer, and the job.
 *
 * The interval maths is pinned in src/domain/recurring.test.ts. What this file is
 * for is the behaviour that would quietly create or destroy money:
 *
 *   - the scheduler generates ONE occurrence per template per tick, so a clock
 *     jump (or three months of downtime) does not insert a stack of bills all
 *     dated today
 *   - generation goes through `createExpense`, so the expense invariant holds and
 *     repayments exist
 *   - editing a template changes FUTURE bills only; the ones already generated do
 *     not move
 *   - deleting a template stops the series and leaves its bills alone
 *   - an occurrence is not a template and can never become one
 *   - a guest link cannot start or stop a series, and editing a bill through one
 *     does not silently end the owner's
 *
 * The scheduler takes `now` as an argument precisely so all of this is testable
 * without waiting a month or touching the system clock.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-recurring-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { runDueRecurrences } = await import("../../domain/scheduler.ts");
const { mintAccessLink } = await import("../../domain/access-links.ts");
const { ulid } = await import("../../domain/ulid.ts");
const { updateExpense } = await import("../../domain/expenses.ts");
const { parseMetadata } = await import("../../domain/metadata.ts");

let aliceId: string;
let bobId: string;
let ghostId: string;
let groupId: string;
let aliceToken: string;
let guestSecret: string;

async function as(token: string, path: string, init: RequestInit = {}) {
  const res = await app.request(`/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

/** Creates a template through the real route, the way the form does. */
async function template(overrides: Record<string, unknown> = {}) {
  const created = await as(aliceToken, "/expenses", {
    method: "POST",
    body: JSON.stringify({
      groupId,
      description: "Rent",
      costMinor: 100_000,
      currencyCode: "USD",
      date: "2026-01-31",
      splitType: "equal",
      repeatInterval: "monthly",
      participants: [
        { userId: aliceId, paidMinor: 100_000 },
        { userId: bobId, paidMinor: 0 },
      ],
      ...overrides,
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.id as string;
}

function occurrencesOf(templateId: string) {
  return db
    .selectFrom("expenses")
    .select(["id", "date", "cost_minor", "description", "repeat_interval", "next_repeat"])
    .where("repeat_of", "=", templateId)
    .where("deleted_at", "is", null)
    .orderBy("date")
    .execute();
}

function row(expenseId: string) {
  return db
    .selectFrom("expenses")
    .select(["id", "repeat_interval", "next_repeat", "repeat_of", "cost_minor", "date", "metadata"])
    .where("id", "=", expenseId)
    .executeTakeFirstOrThrow();
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
      name: "Alice",
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();

  bobId = ulid();
  await db
    .insertInto("users")
    .values({
      id: bobId,
      email: "bob@example.com",
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      name: "Bob",
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();

  ghostId = ulid();
  await db
    .insertInto("users")
    .values({ id: ghostId, name: "Ghost", default_currency: "USD", is_ghost: 1 })
    .execute();

  groupId = ulid();
  await db
    .insertInto("groups")
    .values({ id: groupId, name: "Flat", default_currency: "USD", created_by: aliceId })
    .execute();
  for (const [userId, role] of [
    [aliceId, "owner"],
    [bobId, "member"],
    [ghostId, "member"],
  ] as const) {
    await db
      .insertInto("group_members")
      .values({ group_id: groupId, user_id: userId, role, joined_via: "added" })
      .execute();
  }

  aliceToken = (await createApiToken(aliceId, "test")).token;
  guestSecret = (
    await mintAccessLink(db, {
      kind: "group_member",
      groupId,
      userId: ghostId,
      createdBy: aliceId,
    })
  ).secret;
});

after(async () => {
  await db.destroy();
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe("creating a template", () => {
  test("schedules the first repeat one interval out, not now", async () => {
    const id = await template();
    const stored = await row(id);

    assert.equal(stored.repeat_interval, "monthly");
    // 31 January + 1 month clamps to 28 February. The client never names this
    // date; the server derives it from the expense's own date.
    assert.equal(stored.next_repeat, "2026-02-28T00:00:00.000Z");
    assert.equal(stored.repeat_of, null);
  });

  test("the detail route reports the schedule and the bills so far", async () => {
    const id = await template({ description: "Reported" });
    const detail = await as(aliceToken, `/expenses/${id}`);

    assert.equal(detail.body.expense.repeat_interval, "monthly");
    assert.ok(detail.body.expense.next_repeat);
    assert.equal(detail.body.expense.repeat_paused, null);
    assert.equal(detail.body.expense.series_count, 0);
  });

  test("an unknown interval is refused by the schema", async () => {
    const bad = await as(aliceToken, "/expenses", {
      method: "POST",
      body: JSON.stringify({
        groupId,
        description: "Daily?",
        costMinor: 100,
        currencyCode: "USD",
        date: "2026-01-01",
        splitType: "equal",
        repeatInterval: "daily",
        participants: [{ userId: aliceId, paidMinor: 100 }],
      }),
    });
    assert.equal(bad.status, 400);
  });
});

describe("the scheduler", () => {
  test("does nothing until a template is due", async () => {
    const id = await template({ description: "Not yet", date: "2026-01-31" });
    const run = await runDueRecurrences(new Date("2026-02-01T00:00:00Z"));

    assert.ok(!run.generated.some((g) => g.templateId === id));
    assert.deepEqual(await occurrencesOf(id), []);
  });

  test("generates one bill, dated the day it was due, through the expense writer", async () => {
    const id = await template({ description: "Due", date: "2026-01-31" });

    const run = await runDueRecurrences(new Date("2026-03-01T00:00:00Z"));
    const generated = run.generated.filter((g) => g.templateId === id);
    assert.equal(generated.length, 1);

    const bills = await occurrencesOf(id);
    assert.equal(bills.length, 1);
    assert.equal(bills[0]!.date, "2026-02-28T00:00:00.000Z", "dated when it was due, not today");
    assert.equal(bills[0]!.cost_minor, 100_000);
    assert.equal(bills[0]!.repeat_interval, null, "an occurrence is not itself a template");

    // Through createExpense means shares and repayments exist and add up.
    const shares = await db
      .selectFrom("expense_users")
      .select(["user_id", "owed_share_minor"])
      .where("expense_id", "=", bills[0]!.id)
      .execute();
    assert.equal(shares.length, 2);
    assert.equal(shares.reduce((sum, s) => sum + s.owed_share_minor, 0), 100_000);

    const repayments = await db
      .selectFrom("expense_repayments")
      .select(["from_user_id", "to_user_id", "amount_minor"])
      .where("expense_id", "=", bills[0]!.id)
      .execute();
    assert.equal(repayments.length, 1);
    assert.equal(repayments[0]!.amount_minor, 50_000);

    // And the schedule moved on by exactly one interval.
    assert.equal((await row(id)).next_repeat, "2026-03-28T00:00:00.000Z");
  });

  test("a clock jump does not insert a stack of bills", async () => {
    const id = await template({ description: "Behind", date: "2026-01-01" });

    // A year later. One tick, one bill: the series is deliberately left behind
    // rather than catching up all at once.
    await runDueRecurrences(new Date("2027-01-01T00:00:00Z"));
    assert.equal((await occurrencesOf(id)).length, 1);

    // It catches up one bill per tick, each dated its own due date.
    await runDueRecurrences(new Date("2027-01-01T00:00:00Z"));
    await runDueRecurrences(new Date("2027-01-01T00:00:00Z"));
    const bills = await occurrencesOf(id);
    assert.equal(bills.length, 3);
    assert.deepEqual(
      bills.map((b) => b.date.slice(0, 10)),
      ["2026-02-01", "2026-03-01", "2026-04-01"],
    );
  });

  test("re-running the same tick is idempotent per due date", async () => {
    const id = await template({ description: "Idempotent", date: "2026-01-15" });

    // Rewind the schedule and run twice from the same state: the second pass must
    // see the bill it already made rather than writing a duplicate.
    await runDueRecurrences(new Date("2026-02-20T00:00:00Z"));
    await db
      .updateTable("expenses")
      .set({ next_repeat: "2026-02-15T00:00:00.000Z" })
      .where("id", "=", id)
      .execute();
    const second = await runDueRecurrences(new Date("2026-02-20T00:00:00Z"));

    assert.ok(second.skipped >= 1, "the already-generated bill is skipped, not duplicated");
    assert.equal((await occurrencesOf(id)).length, 1);
  });

  test("a deleted template stops the series and keeps its bills", async () => {
    const id = await template({ description: "Cancelled", date: "2026-01-10" });
    await runDueRecurrences(new Date("2026-02-20T00:00:00Z"));
    const before = await occurrencesOf(id);
    assert.equal(before.length, 1);

    await as(aliceToken, `/expenses/${id}`, { method: "DELETE" });

    await runDueRecurrences(new Date("2027-01-01T00:00:00Z"));
    const after = await occurrencesOf(id);
    assert.equal(after.length, 1, "no new bills");
    assert.equal(after[0]!.id, before[0]!.id, "and the old one is untouched");
  });

  test("deleting one occurrence does not stop the series", async () => {
    const id = await template({ description: "Resilient", date: "2026-01-05" });
    await runDueRecurrences(new Date("2026-02-20T00:00:00Z"));
    const [first] = await occurrencesOf(id);
    await as(aliceToken, `/expenses/${first!.id}`, { method: "DELETE" });

    await runDueRecurrences(new Date("2026-03-20T00:00:00Z"));
    const live = await occurrencesOf(id);
    assert.equal(live.length, 1);
    assert.equal(live[0]!.date.slice(0, 10), "2026-03-05");
  });

  test("one broken template does not stop the others", async () => {
    // Bob leaves the group, so his template's participants are no longer members
    // and createExpense refuses it. The other series must still be generated.
    const broken = await template({ description: "Broken", date: "2026-01-20" });
    const fine = await template({
      description: "Fine",
      date: "2026-01-20",
      participants: [{ userId: aliceId, paidMinor: 100_000 }],
    });

    await db
      .updateTable("group_members")
      .set({ left_at: new Date().toISOString() })
      .where("group_id", "=", groupId)
      .where("user_id", "=", bobId)
      .execute();

    const run = await runDueRecurrences(new Date("2026-03-01T00:00:00Z"));

    assert.ok(run.failures.some((f) => f.templateId === broken));
    assert.ok(run.generated.some((g) => g.templateId === fine));
    assert.deepEqual(await occurrencesOf(broken), []);

    // A failure leaves the schedule where it was, so the next tick retries.
    assert.equal((await row(broken)).next_repeat, "2026-02-20T00:00:00.000Z");

    await db
      .updateTable("group_members")
      .set({ left_at: null })
      .where("group_id", "=", groupId)
      .where("user_id", "=", bobId)
      .execute();
  });
});

describe("editing a series", () => {
  test("changing the amount does not rewrite bills that already happened", async () => {
    const id = await template({ description: "Rising rent", date: "2026-01-08" });
    await runDueRecurrences(new Date("2026-02-20T00:00:00Z"));
    const [past] = await occurrencesOf(id);
    assert.equal(past!.cost_minor, 100_000);

    await as(aliceToken, `/expenses/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        groupId,
        description: "Rising rent",
        costMinor: 120_000,
        currencyCode: "USD",
        date: "2026-01-08",
        splitType: "equal",
        repeatInterval: "monthly",
        participants: [
          { userId: aliceId, paidMinor: 120_000 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });

    assert.equal((await row(past!.id)).cost_minor, 100_000, "the past bill did not move");

    await runDueRecurrences(new Date("2026-03-20T00:00:00Z"));
    const bills = await occurrencesOf(id);
    assert.equal(bills.length, 2);
    assert.equal(bills[1]!.cost_minor, 120_000, "the next one uses the new amount");
  });

  test("an unrelated edit leaves the schedule exactly where it was", async () => {
    const id = await template({ description: "Typo", date: "2026-01-12" });
    const before = (await row(id)).next_repeat;

    await as(aliceToken, `/expenses/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        groupId,
        description: "Typo fixed",
        costMinor: 100_000,
        currencyCode: "USD",
        date: "2026-01-12",
        splitType: "equal",
        repeatInterval: "monthly",
        participants: [
          { userId: aliceId, paidMinor: 100_000 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });

    assert.equal((await row(id)).next_repeat, before, "no bill is skipped or duplicated");
  });

  test("setting the interval to null ends the series", async () => {
    const id = await template({ description: "Ending", date: "2026-01-14" });

    await as(aliceToken, `/expenses/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        groupId,
        description: "Ending",
        costMinor: 100_000,
        currencyCode: "USD",
        date: "2026-01-14",
        splitType: "equal",
        repeatInterval: null,
        participants: [
          { userId: aliceId, paidMinor: 100_000 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });

    const stored = await row(id);
    assert.equal(stored.repeat_interval, null);
    assert.equal(stored.next_repeat, null, "and nothing is left scheduled");
    assert.equal(parseMetadata(stored.metadata).repeat_paused, "monthly");

    const detail = await as(aliceToken, `/expenses/${id}`);
    assert.equal(detail.body.expense.repeat_interval, null);
    assert.equal(detail.body.expense.repeat_paused, "monthly");
    assert.equal(detail.body.expense.metadata, undefined);

    await runDueRecurrences(new Date("2027-01-01T00:00:00Z"));
    assert.deepEqual(await occurrencesOf(id), []);
  });

  test("resuming a stopped series starts from now and does not backfill", async () => {
    const id = await template({ description: "Paused rent", date: "2026-02-21" });

    await as(aliceToken, `/expenses/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        groupId,
        description: "Paused rent",
        costMinor: 100_000,
        currencyCode: "USD",
        date: "2026-02-21",
        splitType: "equal",
        repeatInterval: null,
        participants: [
          { userId: aliceId, paidMinor: 100_000 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });

    await updateExpense(
      id,
      {
        groupId,
        description: "Paused rent",
        costMinor: 100_000,
        currencyCode: "USD",
        date: "2026-02-21",
        splitType: "equal",
        repeatInterval: "monthly",
        participants: [
          { userId: aliceId, paidMinor: 100_000 },
          { userId: bobId, paidMinor: 0 },
        ],
        updatedBy: aliceId,
      },
      new Date("2026-08-18T12:00:00Z"),
    );

    const stored = await row(id);
    assert.equal(stored.repeat_interval, "monthly");
    assert.equal(stored.next_repeat, "2026-08-21T00:00:00.000Z");
    assert.equal(parseMetadata(stored.metadata).repeat_paused, undefined);

    await runDueRecurrences(new Date("2026-07-01T00:00:00Z"));
    assert.equal((await occurrencesOf(id)).length, 0, "missed months are not created");

    await runDueRecurrences(new Date("2026-08-21T12:00:00Z"));
    const bills = await occurrencesOf(id);
    assert.equal(bills.length, 1);
    assert.equal(bills[0]!.date.slice(0, 10), "2026-08-21");
  });

  test("turning repeating on for the first time still schedules from the bill date", async () => {
    const created = await as(aliceToken, "/expenses", {
      method: "POST",
      body: JSON.stringify({
        groupId,
        description: "Late repeat",
        costMinor: 100_000,
        currencyCode: "USD",
        date: "2026-02-21",
        splitType: "equal",
        participants: [
          { userId: aliceId, paidMinor: 100_000 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.id as string;

    await as(aliceToken, `/expenses/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        groupId,
        description: "Late repeat",
        costMinor: 100_000,
        currencyCode: "USD",
        date: "2026-02-21",
        splitType: "equal",
        repeatInterval: "monthly",
        participants: [
          { userId: aliceId, paidMinor: 100_000 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });

    const stored = await row(id);
    assert.equal(stored.next_repeat, "2026-03-21T00:00:00.000Z");
    assert.equal(parseMetadata(stored.metadata).repeat_paused, undefined);
  });

  test("an omitted interval leaves an existing schedule alone", async () => {
    // This is the case that matters for every client without a repeat control:
    // the settle-up form, the guest editor, a script. Absent is not null.
    const id = await template({ description: "Untouched", date: "2026-01-16" });
    const before = (await row(id)).next_repeat;

    await as(aliceToken, `/expenses/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        groupId,
        description: "Untouched, edited",
        costMinor: 100_000,
        currencyCode: "USD",
        date: "2026-01-16",
        splitType: "equal",
        participants: [
          { userId: aliceId, paidMinor: 100_000 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });

    const stored = await row(id);
    assert.equal(stored.repeat_interval, "monthly");
    assert.equal(stored.next_repeat, before);
  });

  test("editing an occurrence cannot turn it into a template", async () => {
    const id = await template({ description: "Parent", date: "2026-01-18" });
    await runDueRecurrences(new Date("2026-02-25T00:00:00Z"));
    const [bill] = await occurrencesOf(id);

    const patched = await as(aliceToken, `/expenses/${bill!.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        groupId,
        description: "Trying to repeat a repeat",
        costMinor: 100_000,
        currencyCode: "USD",
        date: bill!.date,
        splitType: "equal",
        repeatInterval: "weekly",
        participants: [
          { userId: aliceId, paidMinor: 100_000 },
          { userId: bobId, paidMinor: 0 },
        ],
      }),
    });
    assert.equal(patched.status, 200);

    const stored = await row(bill!.id);
    assert.equal(stored.repeat_interval, null, "series stay one level deep");
    assert.equal(stored.next_repeat, null);
    assert.ok(stored.repeat_of);
  });
});

describe("guests and series", () => {
  test("a guest cannot create a template", async () => {
    const created = await app.request("/api/v1/guest/expenses", {
      method: "POST",
      headers: {
        Authorization: `Bearer link_${guestSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        groupId,
        description: "Guest rent",
        costMinor: 1000,
        currencyCode: "USD",
        date: "2026-04-01",
        splitType: "equal",
        repeatInterval: "monthly",
        participants: [
          { userId: ghostId, paidMinor: 1000 },
          { userId: aliceId, paidMinor: 0 },
        ],
      }),
    });

    assert.equal(created.status, 201);
    const { id } = (await created.json()) as { id: string };
    const stored = await row(id);
    // Accepted as an ordinary expense, with the schedule dropped rather than the
    // whole request refused: the guest still wanted to record the bill.
    assert.equal(stored.repeat_interval, null);
    assert.equal(stored.next_repeat, null);
  });

  test("a guest editing a bill does not end the owner's series", async () => {
    const id = await template({
      description: "Owner's series",
      date: "2026-01-22",
      participants: [
        { userId: ghostId, paidMinor: 0 },
        { userId: aliceId, paidMinor: 100_000 },
      ],
    });
    const before = (await row(id)).next_repeat;

    const patched = await app.request(`/api/v1/guest/expenses/${id}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer link_${guestSecret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        groupId,
        description: "Owner's series, tweaked",
        costMinor: 100_000,
        currencyCode: "USD",
        date: "2026-01-22",
        splitType: "equal",
        participants: [
          { userId: ghostId, paidMinor: 0 },
          { userId: aliceId, paidMinor: 100_000 },
        ],
      }),
    });
    assert.equal(patched.status, 200);

    const stored = await row(id);
    assert.equal(stored.repeat_interval, "monthly", "the series survived the guest's edit");
    assert.equal(stored.next_repeat, before);
  });
});
