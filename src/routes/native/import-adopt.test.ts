/**
 * When Alice imports first, Bob already exists here as a ghost. Bob's later
 * import must merge that ghost (API key is the proof) rather than mint a
 * second person and duplicate the shared bills.
 *
 * Own database and fake Splitwise so it cannot collide with import.test.ts,
 * which mutates a shared ledger as it goes.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ALICE_KEY = "test-splitwise-key-alice";
const BOB_KEY = "test-splitwise-key-bob-bob";
const ALICE_SW = 1000;
const BOB_SW = 2001;

const alice = {
  id: ALICE_SW,
  first_name: "Alice",
  last_name: "Anderson",
  email: "alice@example.com",
  registration_status: "confirmed",
};
const bob = {
  id: BOB_SW,
  first_name: "Bob",
  last_name: "Brown",
  email: "bob@example.com",
  registration_status: "confirmed",
};

const swGroup = {
  id: 3001,
  name: "Flat",
  group_type: "apartment",
  members: [alice, bob],
};

const swExpense = {
  id: 4001,
  group_id: 3001,
  description: "Rent",
  cost: "100.00",
  currency_code: "USD",
  date: "2026-03-01T00:00:00Z",
  created_at: "2026-03-02T15:30:00Z",
  category: { id: 18, name: "General" },
  users: [
    { user: alice, paid_share: "100.00", owed_share: "50.00" },
    { user: bob, paid_share: "0.00", owed_share: "50.00" },
  ],
};

function startFake(): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const me =
      req.headers.authorization === `Bearer ${ALICE_KEY}`
        ? alice
        : req.headers.authorization === `Bearer ${BOB_KEY}`
          ? bob
          : null;
    if (!me) return send(401, { error: "Invalid API request: you are not logged in" });

    switch (url.pathname) {
      case "/api/v3.0/get_current_user":
        return send(200, { user: me });
      case "/api/v3.0/get_friends":
        return send(200, { friends: me.id === ALICE_SW ? [bob] : [alice] });
      case "/api/v3.0/get_groups":
        return send(200, {
          groups: [{ id: 0, name: "Non-group expenses", members: [] }, swGroup],
        });
      case "/api/v3.0/get_expenses": {
        const offset = Number(url.searchParams.get("offset") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? 100);
        const all = [swExpense];
        return send(200, { expenses: all.slice(offset, offset + limit) });
      }
      case "/api/v3.0/get_comments":
        return send(200, { comments: [] });
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

const fake = await startFake();
const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-import-adopt-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";
process.env.SPLITWISE_API_BASE = fake.base;

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { ulid } = await import("../../domain/ulid.ts");
const { splitwiseIdOf, parseMetadata } = await import("../../domain/metadata.ts");

let aliceId: string;
let aliceToken: string;
let bobId: string;
let bobToken: string;

async function post(path: string, body: unknown, token: string) {
  const res = await app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
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
  aliceToken = (await createApiToken(aliceId, "test")).token;

  // Different email from Splitwise, so signup does not auto-claim. The API
  // key is the proof this test is exercising.
  bobId = ulid();
  await db
    .insertInto("users")
    .values({
      id: bobId,
      email: "bob-other@example.com",
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      name: "Bob Brown",
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();
  bobToken = (await createApiToken(bobId, "test")).token;
});

after(async () => {
  await db.destroy();
  fake.server.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("second Splitwise import adopts the existing ghost", () => {
  test("Alice's import creates a confirmed ghost for Bob", async () => {
    const run = await post("/import/run", { apiKey: ALICE_KEY }, aliceToken);
    assert.equal(run.status, 200);
    assert.equal(run.body.expenses.imported, 1);

    const ghost = await db
      .selectFrom("users")
      .select(["id", "is_ghost", "invite_email", "metadata"])
      .where("invite_email", "=", "bob@example.com")
      .executeTakeFirstOrThrow();
    assert.equal(ghost.is_ghost, 1);
    assert.equal(splitwiseIdOf(ghost.metadata), BOB_SW);
    assert.equal(parseMetadata(ghost.metadata).splitwise_registration_status, "confirmed");
  });

  test("Bob's preview names the placeholder that will be merged", async () => {
    const preview = await post("/import/preview", { apiKey: BOB_KEY }, bobToken);
    assert.equal(preview.status, 200);
    assert.ok(
      preview.body.warnings.some((w: string) => /placeholder \(Bob Brown\)/i.test(w)),
      "the wizard must say the existing ghost will be merged",
    );
  });

  test("Bob's import merges the ghost and reuses the shared expense", async () => {
    const ghost = await db
      .selectFrom("users")
      .select("id")
      .where("invite_email", "=", "bob@example.com")
      .where("is_ghost", "=", 1)
      .executeTakeFirstOrThrow();

    const run = await post("/import/run", { apiKey: BOB_KEY }, bobToken);
    assert.equal(run.status, 200);
    assert.equal(run.body.expenses.imported, 0, "the shared bill must not be duplicated");
    assert.equal(run.body.expenses.alreadyPresent, 1);

    const stub = await db
      .selectFrom("users")
      .select(["deleted_at", "merged_into_user_id", "metadata"])
      .where("id", "=", ghost.id)
      .executeTakeFirstOrThrow();
    assert.ok(stub.deleted_at);
    assert.equal(stub.merged_into_user_id, bobId);
    assert.equal(splitwiseIdOf(stub.metadata), null);

    const survivor = await db
      .selectFrom("users")
      .select("metadata")
      .where("id", "=", bobId)
      .executeTakeFirstOrThrow();
    assert.equal(splitwiseIdOf(survivor.metadata), BOB_SW);

    const shares = await db
      .selectFrom("expense_users")
      .select("user_id")
      .execute();
    const ids = shares.map((s) => s.user_id).sort();
    assert.deepEqual(ids, [aliceId, bobId].sort());
    assert.equal(shares.length, 2, "one bill, two people, no leftover ghost share");
  });
});
