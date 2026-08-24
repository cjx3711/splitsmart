/**
 * Password reset, end to end against the real Hono app.
 *
 * Tokens live in `email_tokens` with purpose `reset_password`. The request
 * endpoint must not reveal whether an address has an account; completing a
 * reset ends other web sessions and marks the address verified.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-reset-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";
process.env.APP_ORIGIN = "http://localhost:5545";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM_ADDRESS;
delete process.env.POSTMARK_SERVER_TOKEN;
delete process.env.POSTMARK_FROM_ADDRESS;

const { migrate } = await import("../db/migrate.ts");
const { seed } = await import("../db/seed.ts");
const { app } = await import("../server.ts");
const { db } = await import("../db/index.ts");
const { issuePasswordReset, lookupPasswordReset, completePasswordReset } = await import(
  "./reset.ts"
);
const { hashPassword, verifyPassword, hashToken, generateToken } = await import(
  "../auth/password.ts"
);
const { createSession, createApiToken, SESSION_COOKIE } = await import("../auth/session.ts");
const { ulid } = await import("../domain/ulid.ts");

before(() => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/**
 * Issues a token and returns the plaintext.
 *
 * The app only ever stores hashes, so a test cannot read the real token back
 * out. Instead we generate one, overwrite the stored hash with its digest, and
 * carry on, equivalent to intercepting the email.
 */
async function issueAndCapture(email: string): Promise<string> {
  const outcome = await issuePasswordReset(email);
  assert.equal(outcome.status, "sent", JSON.stringify(outcome));
  const plaintext = generateToken(32);
  const user = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("email_tokens")
    .set({ token_hash: hashToken(plaintext) })
    .where("user_id", "=", user.id)
    .where("purpose", "=", "reset_password")
    .where("used_at", "is", null)
    .execute();
  return plaintext;
}

let counter = 0;
async function realUser(opts: { verified?: boolean } = {}): Promise<{
  id: string;
  email: string;
  password: string;
}> {
  const email = `reset${++counter}@example.com`;
  const password = "hunter2hunter2";
  const id = ulid();
  await db
    .insertInto("users")
    .values({
      id,
      email,
      password_hash: await hashPassword(password),
      name: "Resettable",
      is_ghost: 0,
      email_verified_at: opts.verified === false ? null : new Date().toISOString(),
    })
    .execute();
  return { id, email, password };
}

function cookieHeader(setCookie: string | undefined): string {
  assert.ok(setCookie, "expected a session cookie");
  const token = setCookie.split(";")[0];
  assert.ok(token);
  return token;
}

describe("POST /api/v1/auth/password/forgot", () => {
  test("returns the same body whether or not the address has an account", async () => {
    const user = await realUser();
    const known = await app.request("/api/v1/auth/password/forgot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email }),
    });
    const unknown = await app.request("/api/v1/auth/password/forgot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `nobody${counter}@example.com` }),
    });

    assert.equal(known.status, 200);
    assert.equal(unknown.status, 200);
    assert.deepEqual(await known.json(), { ok: true });
    assert.deepEqual(await unknown.json(), { ok: true });
  });

  test("does not write a token for an unknown address", async () => {
    const before = await db
      .selectFrom("email_tokens")
      .select("id")
      .where("purpose", "=", "reset_password")
      .execute();

    await issuePasswordReset(`missing${++counter}@example.com`);

    const after = await db
      .selectFrom("email_tokens")
      .select("id")
      .where("purpose", "=", "reset_password")
      .execute();
    assert.equal(after.length, before.length);
  });

  test("does not write a token for a ghost carrying an invite address", async () => {
    const id = ulid();
    await db
      .insertInto("users")
      .values({
        id,
        name: "Invited",
        email: null,
        invite_email: `ghost-reset${++counter}@example.com`,
        is_ghost: 1,
      })
      .execute();

    assert.deepEqual(await issuePasswordReset(`ghost-reset${counter}@example.com`), {
      status: "no_account",
    });
  });

  test("is rate limited per account without changing the HTTP response", async () => {
    const user = await realUser();
    await issuePasswordReset(user.email);

    const res = await app.request("/api/v1/auth/password/forgot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });

    const tokens = await db
      .selectFrom("email_tokens")
      .select("id")
      .where("user_id", "=", user.id)
      .where("purpose", "=", "reset_password")
      .where("used_at", "is", null)
      .execute();
    assert.equal(tokens.length, 1);
  });
});

describe("GET /api/v1/auth/password/reset/:token", () => {
  test("returns the address without consuming the token", async () => {
    const user = await realUser();
    const token = await issueAndCapture(user.email);

    const res = await app.request(`/api/v1/auth/password/reset/${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, email: user.email });

    const second = await lookupPasswordReset(token);
    assert.deepEqual(second, { status: "pending", email: user.email });
  });

  test("rejects an unknown token", async () => {
    const res = await app.request(`/api/v1/auth/password/reset/${generateToken(32)}`);
    assert.equal(res.status, 404);
  });
});

describe("POST /api/v1/auth/password/reset/:token", () => {
  test("sets the new password, opens a session, and ends the old one", async () => {
    const user = await realUser();
    const { token: oldSession } = await createSession(user.id, "old-browser");
    const apiToken = (await createApiToken(user.id, "keep-me")).token;
    const token = await issueAndCapture(user.email);

    const res = await app.request(`/api/v1/auth/password/reset/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "new-password-ok" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      user: { id: string; emailVerified: boolean; needsEmailVerification: boolean };
    };
    assert.equal(body.user.id, user.id);
    assert.equal(body.user.emailVerified, true);
    assert.equal(body.user.needsEmailVerification, false);

    const cookie = cookieHeader(res.headers.get("set-cookie") ?? undefined);
    const me = await app.request("/api/v1/auth/me", { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);

    const oldMe = await app.request("/api/v1/auth/me", {
      headers: { Cookie: `${SESSION_COOKIE}=${oldSession}` },
    });
    assert.equal(oldMe.status, 401);

    const stillAuthed = await app.request("/api/v1/auth/me", {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(stillAuthed.status, 200);

    const oldLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: user.password }),
    });
    assert.equal(oldLogin.status, 401);

    const newLogin = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: "new-password-ok" }),
    });
    assert.equal(newLogin.status, 200);
  });

  test("marks an unverified address verified", async () => {
    const user = await realUser({ verified: false });
    const token = await issueAndCapture(user.email);
    const result = await completePasswordReset(token, await hashPassword("new-password-ok"));
    assert.equal(result.status, "reset");

    const row = await db
      .selectFrom("users")
      .select(["email_verified_at", "password_hash"])
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    assert.ok(row.email_verified_at);
    assert.equal(await verifyPassword("new-password-ok", row.password_hash!), true);
  });

  test("rejects a second use of the same link", async () => {
    const user = await realUser();
    const token = await issueAndCapture(user.email);
    await completePasswordReset(token, await hashPassword("new-password-ok"));

    const res = await app.request(`/api/v1/auth/password/reset/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "another-password" }),
    });
    assert.equal(res.status, 410);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "already_used");
  });

  test("rejects an expired token", async () => {
    const user = await realUser();
    const token = await issueAndCapture(user.email);
    await db
      .updateTable("email_tokens")
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where("user_id", "=", user.id)
      .where("purpose", "=", "reset_password")
      .where("used_at", "is", null)
      .execute();

    const result = await completePasswordReset(token, await hashPassword("new-password-ok"));
    assert.equal(result.status, "expired");
    assert.equal(await verifyPassword(user.password, (await db
      .selectFrom("users")
      .select("password_hash")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow()).password_hash!), true);
  });

  test("issuing a new token invalidates the previous one", async () => {
    const user = await realUser();
    const first = await issueAndCapture(user.email);
    await db
      .updateTable("email_tokens")
      .set({ created_at: "2020-01-01 00:00:00" })
      .where("user_id", "=", user.id)
      .where("purpose", "=", "reset_password")
      .execute();

    await issueAndCapture(user.email);

    const result = await completePasswordReset(first, await hashPassword("new-password-ok"));
    assert.equal(result.status, "already_used");
  });

  test("refuses a token whose address changed after issue", async () => {
    const user = await realUser();
    const token = await issueAndCapture(user.email);
    await db
      .updateTable("users")
      .set({ email: `changed-reset${counter}@example.com` })
      .where("id", "=", user.id)
      .execute();

    const result = await completePasswordReset(token, await hashPassword("new-password-ok"));
    assert.equal(result.status, "email_changed");
  });

  test("rejects a password that is too short", async () => {
    const user = await realUser();
    const token = await issueAndCapture(user.email);
    const res = await app.request(`/api/v1/auth/password/reset/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "short" }),
    });
    assert.equal(res.status, 400);
  });
});
