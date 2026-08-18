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
