/**
 * Admin usage panel: authz, search, counts, and the as_of chart window.
 *
 * ADMIN_EMAILS must be set before importing anything that reaches src/env.ts,
 * because the set is frozen at import.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-admin-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";
process.env.ADMIN_EMAILS = "alice@example.com,  Other@Example.COM ";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense } = await import("../../domain/expenses.ts");
const { addFriendship } = await import("../../domain/friends.ts");
const { mintAccessLink } = await import("../../domain/access-links.ts");
const { ulid } = await import("../../domain/ulid.ts");
const { parseAdminEmails } = await import("../../env.ts");
const {
  parseAsOf,
  daysEndingOn,
  USAGE_WINDOW_DAYS,
} = await import("../../domain/admin-stats.ts");

let aliceId: string;
let bobId: string;
let ghostId: string;
let deletedId: string;
let groupId: string;
let aliceToken: string;
let bobToken: string;
let linkToken: string;

async function realUser(name: string, email: string): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({
      id,
      email,
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      name,
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();
  return id;
}

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  aliceId = await realUser("Alice Anderson", "alice@example.com");
  bobId = await realUser("Bob Brown", "bob@example.com");
  deletedId = await realUser("Gone User", "gone@example.com");
  await db
    .updateTable("users")
    .set({ deleted_at: "2026-01-01 00:00:00" })
    .where("id", "=", deletedId)
    .execute();

  ghostId = ulid();
  await db
    .insertInto("users")
    .values({
      id: ghostId,
      name: "Ghost Guy",
      default_currency: "USD",
      is_ghost: 1,
    })
    .execute();

  groupId = ulid();
  await db
    .insertInto("groups")
    .values({
      id: groupId,
      name: "Admin Trip",
      group_type: "trip",
      default_currency: "USD",
      created_by: aliceId,
    })
    .execute();
  for (const [userId, role] of [
    [aliceId, "owner"],
    [bobId, "member"],
    [ghostId, "member"],
  ] as const) {
    await db
      .insertInto("group_members")
      .values({
        group_id: groupId,
        user_id: userId,
        role,
        joined_via: "added",
      })
      .execute();
  }

  await addFriendship(aliceId, ghostId, aliceId);

  // Alice created two bills dated inside the window; Bob created one Alice is on.
  await createExpense({
    groupId,
    description: "Alice lunch",
    costMinor: 3000,
    currencyCode: "USD",
    date: "2026-08-10T00:00:00.000Z",
    splitType: "equal",
    participants: [
      { userId: aliceId, paidMinor: 3000 },
      { userId: bobId, paidMinor: 0 },
    ],
    createdBy: aliceId,
  });
  await createExpense({
    groupId,
    description: "Alice dinner",
    costMinor: 4000,
    currencyCode: "USD",
    date: "2026-08-15T00:00:00.000Z",
    splitType: "equal",
    participants: [
      { userId: aliceId, paidMinor: 4000 },
      { userId: ghostId, paidMinor: 0 },
    ],
    createdBy: aliceId,
  });
  await createExpense({
    groupId,
    description: "Bob coffee",
    costMinor: 500,
    currencyCode: "USD",
    date: "2026-08-12T00:00:00.000Z",
    splitType: "equal",
    participants: [
      { userId: bobId, paidMinor: 500 },
      { userId: aliceId, paidMinor: 0 },
    ],
    createdBy: bobId,
  });
  // Outside the as_of=2026-08-18 window (starts 2026-07-20).
  await createExpense({
    groupId,
    description: "Old trip",
    costMinor: 1000,
    currencyCode: "USD",
    date: "2026-06-01T00:00:00.000Z",
    splitType: "equal",
    participants: [
      { userId: aliceId, paidMinor: 1000 },
      { userId: bobId, paidMinor: 0 },
    ],
    createdBy: aliceId,
  });

  // Recurring template Alice is on.
  await createExpense({
    groupId,
    description: "Rent",
    costMinor: 200_000,
    currencyCode: "USD",
    date: "2026-08-01T00:00:00.000Z",
    splitType: "equal",
    participants: [
      { userId: aliceId, paidMinor: 200_000 },
      { userId: bobId, paidMinor: 0 },
    ],
    createdBy: aliceId,
    repeatInterval: "monthly",
  });

  const live = await mintAccessLink(db, {
    kind: "group",
    groupId,
    createdBy: aliceId,
  });
  linkToken = `link_${live.secret}`;
  const revoked = await mintAccessLink(db, {
    kind: "friend",
    userId: ghostId,
    createdBy: aliceId,
  });
  await db
    .updateTable("access_links")
    .set({ revoked_at: "2026-08-01 00:00:00" })
    .where("id", "=", revoked.id)
    .execute();

  aliceToken = (await createApiToken(aliceId, "alice")).token;
  bobToken = (await createApiToken(bobId, "bob")).token;
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function authed(token: string, path: string, init: RequestInit = {}) {
  return app.request(path, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("parseAdminEmails", () => {
  test("empty string yields an empty set", () => {
    assert.equal(parseAdminEmails("").size, 0);
  });

  test("trims, lower-cases, and drops empties", () => {
    const set = parseAdminEmails("  Alice@Example.com , ,BOB@example.com ");
    assert.equal(set.size, 2);
    assert.ok(set.has("alice@example.com"));
    assert.ok(set.has("bob@example.com"));
  });
});

describe("as_of helpers", () => {
  test("parseAsOf accepts a valid day and rejects garbage", () => {
    assert.equal(parseAsOf("2026-08-18"), "2026-08-18");
    assert.equal(parseAsOf("2026-02-30"), utcToday());
    assert.equal(parseAsOf("nope"), utcToday());
    assert.equal(parseAsOf(undefined), utcToday());
  });

  test("daysEndingOn is 30 days inclusive ending on asOf", () => {
    const days = daysEndingOn("2026-08-18");
    assert.equal(days.length, USAGE_WINDOW_DAYS);
    assert.equal(days[0], "2026-07-20");
    assert.equal(days[days.length - 1], "2026-08-18");
  });
});

function utcToday(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

describe("GET /api/v1/auth/me isAdmin", () => {
  test("alice is admin, bob is not", async () => {
    const aliceRes = await authed(aliceToken, "/api/v1/auth/me");
    const alice = (await aliceRes.json()) as { user: { isAdmin: boolean } };
    const bobRes = await authed(bobToken, "/api/v1/auth/me");
    const bob = (await bobRes.json()) as { user: { isAdmin: boolean } };
    assert.equal(alice.user.isAdmin, true);
    assert.equal(bob.user.isAdmin, false);
  });
});

describe("GET /api/v1/admin/users", () => {
  test("401 without auth", async () => {
    const res = await app.request("/api/v1/admin/users");
    assert.equal(res.status, 401);
  });

  test("401 with a guest link token", async () => {
    const res = await app.request("/api/v1/admin/users", {
      headers: { Authorization: `Bearer ${linkToken}` },
    });
    assert.equal(res.status, 401);
  });

  test("403 for a non-admin", async () => {
    const res = await authed(bobToken, "/api/v1/admin/users");
    assert.equal(res.status, 403);
  });

  test("lists real users only; search by name and email", async () => {
    const allRes = await authed(aliceToken, "/api/v1/admin/users?as_of=2026-08-18");
    const all = (await allRes.json()) as {
      asOf: string;
      users: Array<{ id: string; name: string; email: string | null }>;
    };
    assert.equal(all.asOf, "2026-08-18");
    const ids = new Set(all.users.map((u) => u.id));
    assert.ok(ids.has(aliceId));
    assert.ok(ids.has(bobId));
    assert.ok(!ids.has(ghostId));
    assert.ok(!ids.has(deletedId));

    const byNameRes = await authed(
      aliceToken,
      "/api/v1/admin/users?q=bob&as_of=2026-08-18",
    );
    const byName = (await byNameRes.json()) as { users: Array<{ id: string }> };
    assert.equal(byName.users.length, 1);
    assert.equal(byName.users[0]!.id, bobId);

    const byEmailRes = await authed(
      aliceToken,
      "/api/v1/admin/users?q=alice@&as_of=2026-08-18",
    );
    const byEmail = (await byEmailRes.json()) as { users: Array<{ id: string }> };
    assert.equal(byEmail.users.length, 1);
    assert.equal(byEmail.users[0]!.id, aliceId);
  });

  test("same created_at breaks by name, then id", async () => {
    const stamp = "2020-01-01 00:00:00";
    const zedId = ulid();
    const amyId = ulid();
    await db
      .insertInto("users")
      .values([
        {
          id: zedId,
          email: "zed-tie@example.com",
          password_hash: "scrypt$131072$8$1$AAAA$AAAA",
          name: "Zed Tie",
          default_currency: "USD",
          is_ghost: 0,
          created_at: stamp,
        },
        {
          id: amyId,
          email: "amy-tie@example.com",
          password_hash: "scrypt$131072$8$1$AAAA$AAAA",
          name: "Amy Tie",
          default_currency: "USD",
          is_ghost: 0,
          created_at: stamp,
        },
      ])
      .execute();

    const res = await authed(aliceToken, "/api/v1/admin/users?q=Tie&as_of=2026-08-18");
    const body = (await res.json()) as { users: Array<{ id: string; name: string }> };
    assert.deepEqual(
      body.users.map((u) => u.name),
      ["Amy Tie", "Zed Tie"],
    );

    await db.deleteFrom("users").where("id", "in", [zedId, amyId]).execute();
  });

  test("counts and series for alice", async () => {
    const res = await authed(
      aliceToken,
      "/api/v1/admin/users?q=Alice&as_of=2026-08-18",
    );
    const body = (await res.json()) as {
      users: Array<{
        id: string;
        counts: Record<string, number>;
        series: Array<{ date: string; count: number }>;
      }>;
    };
    assert.equal(body.users.length, 1);
    const u = body.users[0]!;
    assert.equal(u.id, aliceId);
    // 3 created by alice (lunch, dinner, old) + rent template = 4
    assert.equal(u.counts.expensesCreated, 4);
    // lunch, dinner, bob's coffee, old, rent = 5
    assert.equal(u.counts.expensesParticipated, 5);
    assert.equal(u.counts.groups, 1);
    // bob + ghost via group; ghost also via friendship
    assert.ok((u.counts.friends ?? 0) >= 2);
    assert.equal(u.counts.recurring, 1);
    assert.equal(u.counts.guestLinks, 1); // live group link; friend link revoked
    assert.equal(u.counts.ghosts, 1);

    assert.equal(u.series.length, 30);
    assert.equal(u.series[0]!.date, "2026-07-20");
    assert.equal(u.series[29]!.date, "2026-08-18");
    const byDate = Object.fromEntries(u.series.map((d) => [d.date, d.count]));
    assert.equal(byDate["2026-08-10"], 1);
    assert.equal(byDate["2026-08-15"], 1);
    assert.equal(byDate["2026-08-01"], 1); // rent
    assert.equal(byDate["2026-06-01"], undefined); // outside window / zero-filled absent
    assert.equal(byDate["2026-07-20"], 0);
  });
});

describe("GET /api/v1/admin/users/:id", () => {
  test("returns one user", async () => {
    const res = await authed(aliceToken, `/api/v1/admin/users/${bobId}?as_of=2026-08-18`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      user: { id: string; counts: { expensesCreated: number } };
    };
    assert.equal(body.user.id, bobId);
    assert.equal(body.user.counts.expensesCreated, 1);
  });

  test("404 for a ghost id", async () => {
    const res = await authed(aliceToken, `/api/v1/admin/users/${ghostId}?as_of=2026-08-18`);
    assert.equal(res.status, 404);
  });

  test("404 for a deleted user", async () => {
    const res = await authed(aliceToken, `/api/v1/admin/users/${deletedId}?as_of=2026-08-18`);
    assert.equal(res.status, 404);
  });
});

describe("GET /api/v1/admin/backups", () => {
  test("401 without auth", async () => {
    const res = await app.request("/api/v1/admin/backups");
    assert.equal(res.status, 401);
  });

  test("403 for a non-admin", async () => {
    const res = await authed(bobToken, "/api/v1/admin/backups");
    assert.equal(res.status, 403);
  });

  test("200 with redacted config even when backups are unconfigured", async () => {
    const res = await authed(aliceToken, "/api/v1/admin/backups");
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      config: { status: string; problems: Array<{ key: string; reason: string }> };
      scheduler: { state: string };
      stats: { total: number; consecutiveFailures: number };
      runs: unknown[];
      databaseError: string | null;
    };
    assert.equal(body.config.status, "unconfigured");
    assert.ok(body.config.problems.some((p) => p.key === "BACKUP_S3_BUCKET"));
    assert.equal(body.scheduler.state, "unknown");
    assert.equal(body.stats.total, 0);
    assert.deepEqual(body.runs, []);
    assert.equal(body.databaseError, null);
  });
});

describe("POST /api/v1/admin/backups", () => {
  test("403 for a non-admin", async () => {
    const res = await authed(bobToken, "/api/v1/admin/backups", { method: "POST" });
    assert.equal(res.status, 403);
  });

  test("503 when backups are not configured", async () => {
    const res = await authed(aliceToken, "/api/v1/admin/backups", { method: "POST" });
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "not_configured");
  });
});
