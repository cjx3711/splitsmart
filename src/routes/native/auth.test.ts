/**
 * Native auth: the bits that aren't covered by the verification flow tests.
 *
 * PATCH /me is how the preferred-currency setting is saved. It must validate
 * against the currencies table the same way /register does, and return the
 * same shape as GET /me so the client can drop the result straight into
 * session state.
 *
 * DATABASE_PATH is set before importing anything that opens the database,
 * because src/db/index.ts opens a connection at module load.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-auth-test-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { ulid } = await import("../../domain/ulid.ts");
const { serializeMetadata, splitwiseIdOf, parseMetadata } = await import("../../domain/metadata.ts");

let apiToken: string;
let userId: string;

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  userId = ulid();
  await db
    .insertInto("users")
    .values({
      id: userId,
      email: "alice@example.com",
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      name: "Alice Anderson",
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();
  apiToken = (await createApiToken(userId, "test")).token;
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

describe("PATCH /api/v1/auth/me", () => {
  test("updates default_currency and returns the GET /me shape", async () => {
    const res = await authed("/api/v1/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ defaultCurrency: "jpy" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { user: Record<string, unknown> };
    assert.equal(body.user.defaultCurrency, "JPY");
    assert.equal(body.user.id, userId);
    assert.equal(body.user.email, "alice@example.com");
    assert.equal(body.user.name, "Alice Anderson");
    assert.equal(body.user.isGhost, false);
    assert.equal(typeof body.user.emailVerified, "boolean");
    assert.equal(typeof body.user.needsEmailVerification, "boolean");

    const stored = await db
      .selectFrom("users")
      .select("default_currency")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    assert.equal(stored.default_currency, "JPY");

    const me = await authed("/api/v1/auth/me");
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { user: { defaultCurrency: string } };
    assert.equal(meBody.user.defaultCurrency, "JPY");
  });

  test("rejects an unknown currency with 400", async () => {
    const res = await authed("/api/v1/auth/me", {
      method: "PATCH",
      body: JSON.stringify({ defaultCurrency: "ZZZ" }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Unknown currency/);

    const stored = await db
      .selectFrom("users")
      .select("default_currency")
      .where("id", "=", userId)
      .executeTakeFirstOrThrow();
    assert.equal(stored.default_currency, "JPY");
  });

  test("requires auth", async () => {
    const res = await app.request("/api/v1/auth/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultCurrency: "USD" }),
    });
    assert.equal(res.status, 401);
  });

  test("updates name, nickname and icon and returns them on GET /me", async () => {
    const res = await authed("/api/v1/auth/me", {
      method: "PATCH",
      body: JSON.stringify({
        name: "Tanaka Yuki",
        nickname: "Yuki",
        iconLetters: "雪",
        iconEmoji: "🌸",
        iconHue: 48,
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { user: Record<string, unknown> };
    assert.equal(body.user.name, "Tanaka Yuki");
    assert.equal(body.user.nickname, "Yuki");
    assert.equal(body.user.iconLetters, "雪");
    assert.equal(body.user.iconEmoji, "🌸");
    assert.equal(body.user.iconHue, 48);

    const me = await authed("/api/v1/auth/me");
    const meBody = (await me.json()) as { user: Record<string, unknown> };
    assert.equal(meBody.user.nickname, "Yuki");
    assert.equal(meBody.user.iconHue, 48);
  });
});

describe("POST /api/v1/auth/register Splitwise ghost claim", () => {
  async function makeImportedGhost(opts: {
    email: string;
    name: string;
    splitwiseId?: number;
    status?: string;
  }): Promise<string> {
    const id = ulid();
    const metadata =
      opts.splitwiseId != null
        ? serializeMetadata({
            splitwise_id: opts.splitwiseId,
            ...(opts.status ? { splitwise_registration_status: opts.status } : {}),
          })
        : "{}";
    await db
      .insertInto("users")
      .values({
        id,
        name: opts.name,
        default_currency: "USD",
        is_ghost: 1,
        invite_email: opts.email,
        metadata,
      })
      .execute();
    return id;
  }

  async function register(email: string, name: string) {
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "password1",
        name,
        defaultCurrency: "USD",
      }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  test("merges a confirmed Splitwise ghost whose invite email matches", async () => {
    const ghostId = await makeImportedGhost({
      email: "claimed@example.com",
      name: "Imported Bob",
      splitwiseId: 2001,
      status: "confirmed",
    });

    const { status, body } = await register("claimed@example.com", "Bob Brown");
    assert.equal(status, 201);
    assert.equal(body.claimedImportedHistory, true);

    const user = body.user as { id: string };
    const stub = await db
      .selectFrom("users")
      .select(["deleted_at", "merged_into_user_id", "metadata"])
      .where("id", "=", ghostId)
      .executeTakeFirstOrThrow();
    assert.ok(stub.deleted_at);
    assert.equal(stub.merged_into_user_id, user.id);
    assert.equal(splitwiseIdOf(stub.metadata), null);

    const survivor = await db
      .selectFrom("users")
      .select("metadata")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    assert.equal(splitwiseIdOf(survivor.metadata), 2001);
    assert.equal(parseMetadata(survivor.metadata).splitwise_registration_status, "confirmed");
  });

  test("does not merge a dummy Splitwise ghost on signup", async () => {
    const ghostId = await makeImportedGhost({
      email: "dummy@example.com",
      name: "Dummy Carol",
      splitwiseId: 2002,
      status: "dummy",
    });

    const { status, body } = await register("dummy@example.com", "Carol Clark");
    assert.equal(status, 201);
    assert.equal(body.claimedImportedHistory, false);

    const ghost = await db
      .selectFrom("users")
      .select(["deleted_at", "is_ghost"])
      .where("id", "=", ghostId)
      .executeTakeFirstOrThrow();
    assert.equal(ghost.deleted_at, null);
    assert.equal(ghost.is_ghost, 1);
  });

  test("does not merge an invite-only ghost with no Splitwise id", async () => {
    const ghostId = await makeImportedGhost({
      email: "invited@example.com",
      name: "Invited Dan",
    });

    const { status, body } = await register("invited@example.com", "Dan");
    assert.equal(status, 201);
    assert.equal(body.claimedImportedHistory, false);

    const ghost = await db
      .selectFrom("users")
      .select("deleted_at")
      .where("id", "=", ghostId)
      .executeTakeFirstOrThrow();
    assert.equal(ghost.deleted_at, null);
  });

  test("does not merge when two confirmed ghosts share the invite email", async () => {
    await makeImportedGhost({
      email: "shared@example.com",
      name: "One",
      splitwiseId: 3001,
      status: "confirmed",
    });
    await makeImportedGhost({
      email: "shared@example.com",
      name: "Two",
      splitwiseId: 3002,
      status: "confirmed",
    });

    const { status, body } = await register("shared@example.com", "Shared");
    assert.equal(status, 201);
    assert.equal(body.claimedImportedHistory, false);

    const live = await db
      .selectFrom("users")
      .select("id")
      .where("invite_email", "=", "shared@example.com")
      .where("deleted_at", "is", null)
      .execute();
    assert.equal(live.length, 2, "ambiguous matches must be left for a guest-link claim");
  });
});
