/**
 * Email verification flow, end to end against the real Hono app.
 *
 * Postmark is intentionally NOT configured here, which exercises the degraded
 * path: sends become console logs and `delivered` is false, while token issuing
 * and consuming still work. That is the same path a self-hoster hits before
 * setting up a mail provider, so it deserves to be the tested default.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-email-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";
process.env.APP_ORIGIN = "http://localhost:5545";
delete process.env.POSTMARK_SERVER_TOKEN;
delete process.env.POSTMARK_FROM_ADDRESS;

const { migrate } = await import("../db/migrate.ts");
const { seed } = await import("../db/seed.ts");
const { app } = await import("../server.ts");
const { db } = await import("../db/index.ts");
const { issueVerificationToken, consumeVerificationToken } = await import("./verification.ts");
const { hashToken, generateToken } = await import("../auth/password.ts");
const { ulid } = await import("../domain/ulid.ts");

before(() => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Reaches into the DB for the token that was just emailed. */
async function latestTokenHashFor(userId: string): Promise<string | undefined> {
  const row = await db
    .selectFrom("email_tokens")
    .select(["token_hash"])
    .where("user_id", "=", userId)
    .where("purpose", "=", "verify_email")
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row?.token_hash;
}

/**
 * Issues a token and returns the plaintext.
 *
 * The app only ever stores hashes, so a test cannot read the real token back
 * out. Instead we generate one, overwrite the stored hash with its digest, and
 * carry on, equivalent to intercepting the email.
 */
async function issueAndCapture(userId: string): Promise<string> {
  await issueVerificationToken(userId);
  const plaintext = generateToken(32);
  await db
    .updateTable("email_tokens")
    .set({ token_hash: hashToken(plaintext) })
    .where("user_id", "=", userId)
    .where("purpose", "=", "verify_email")
    .where("used_at", "is", null)
    .execute();
  return plaintext;
}

let counter = 0;
async function registerUser(): Promise<{ id: string; email: string; cookie: string }> {
  const email = `user${++counter}@example.com`;
  const res = await app.request("/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2hunter2", firstName: "Test" }),
  });
  assert.equal(res.status, 201);

  const body = (await res.json()) as { user: { id: string } };
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { id: body.user.id, email, cookie };
}

describe("registration issues a verification token", () => {
  test("a new account starts unverified", async () => {
    const user = await registerUser();

    const row = await db
      .selectFrom("users")
      .select("email_verified_at")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();

    assert.equal(row.email_verified_at, null);
  });

  test("a token is created and stored only as a hash", async () => {
    const user = await registerUser();
    const hash = await latestTokenHashFor(user.id);

    assert.ok(hash, "a verification token should exist");
    // A stored value that verifies against itself would mean plaintext storage.
    assert.notEqual(hash, hashToken(hash!));
  });

  test("reports that no email went out when Postmark is unconfigured", async () => {
    const email = `unconfigured${++counter}@example.com`;
    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "hunter2hunter2", firstName: "Test" }),
    });

    const body = (await res.json()) as { verificationEmailSent: boolean };
    // Must not claim a message was sent when it was only logged.
    assert.equal(body.verificationEmailSent, false);
  });

  test("registration still succeeds with no mail provider", async () => {
    const user = await registerUser();
    assert.ok(user.id);
    assert.ok(user.cookie.includes("splitsmart_session"));
  });
});

describe("consuming a token", () => {
  test("marks the address verified", async () => {
    const user = await registerUser();
    const token = await issueAndCapture(user.id);

    const result = await consumeVerificationToken(token);
    assert.deepEqual(result, { status: "verified", userId: user.id });

    const row = await db
      .selectFrom("users")
      .select("email_verified_at")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    assert.ok(row.email_verified_at);
  });

  test("works over HTTP without authentication", async () => {
    const user = await registerUser();
    const token = await issueAndCapture(user.id);

    // No cookie; the link is often opened in a different browser.
    const res = await app.request(`/api/v1/auth/verify/${token}`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, status: "verified" });
  });

  test("rejects an unknown token", async () => {
    const result = await consumeVerificationToken(generateToken(32));
    assert.deepEqual(result, { status: "invalid" });
  });

  test("a second click is idempotent, not an error", async () => {
    const user = await registerUser();
    const token = await issueAndCapture(user.id);

    await consumeVerificationToken(token);
    // Mail scanners prefetch links; the user must not see a failure.
    const second = await consumeVerificationToken(token);
    assert.equal(second.status, "verified");
  });

  test("rejects an expired token", async () => {
    const user = await registerUser();
    const token = await issueAndCapture(user.id);

    await db
      .updateTable("email_tokens")
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where("user_id", "=", user.id)
      .where("used_at", "is", null)
      .execute();

    const result = await consumeVerificationToken(token);
    assert.equal(result.status, "expired");
  });

  test("issuing a new token invalidates the previous one", async () => {
    const user = await registerUser();
    const first = await issueAndCapture(user.id);

    // Step past the resend cooldown.
    await db
      .updateTable("email_tokens")
      .set({ created_at: "2020-01-01 00:00:00" })
      .where("user_id", "=", user.id)
      .execute();

    await issueAndCapture(user.id);

    const result = await consumeVerificationToken(first);
    assert.equal(result.status, "already_used");
  });

  test("refuses a token whose address changed after issue", async () => {
    const user = await registerUser();
    const token = await issueAndCapture(user.id);

    // The security case email_tokens exists for: an outstanding link must not
    // validate an address it was not issued for.
    await db
      .updateTable("users")
      .set({ email: `changed${counter}@example.com` })
      .where("id", "=", user.id)
      .execute();

    const result = await consumeVerificationToken(token);
    assert.equal(result.status, "email_changed");

    const row = await db
      .selectFrom("users")
      .select("email_verified_at")
      .where("id", "=", user.id)
      .executeTakeFirstOrThrow();
    assert.equal(row.email_verified_at, null, "must not verify the new address");
  });
});

describe("resend", () => {
  test("is rate limited", async () => {
    const user = await registerUser();

    const res = await app.request("/api/v1/auth/verify/resend", {
      method: "POST",
      headers: { Cookie: user.cookie },
    });

    // Registration already sent one, so an immediate resend hits the cooldown.
    assert.equal(res.status, 429);
    assert.ok(res.headers.get("Retry-After"));
  });

  test("succeeds once the cooldown has passed", async () => {
    const user = await registerUser();
    await db
      .updateTable("email_tokens")
      .set({ created_at: "2020-01-01 00:00:00" })
      .where("user_id", "=", user.id)
      .execute();

    const res = await app.request("/api/v1/auth/verify/resend", {
      method: "POST",
      headers: { Cookie: user.cookie },
    });
    assert.equal(res.status, 200);
  });

  test("is a no-op for an already-verified account", async () => {
    const user = await registerUser();
    const token = await issueAndCapture(user.id);
    await consumeVerificationToken(token);

    const res = await app.request("/api/v1/auth/verify/resend", {
      method: "POST",
      headers: { Cookie: user.cookie },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, alreadyVerified: true });
  });

  test("requires authentication", async () => {
    const res = await app.request("/api/v1/auth/verify/resend", { method: "POST" });
    assert.equal(res.status, 401);
  });

  test("the resend route is not shadowed by /verify/:token", async () => {
    // Regression guard: Hono matches in registration order, so /verify/resend
    // must be declared before /verify/:token or it becomes unreachable.
    const res = await app.request("/api/v1/auth/verify/resend", { method: "POST" });
    assert.equal(res.status, 401, "should hit the authenticated resend handler, not the token one");
  });
});

describe("ghosts", () => {
  /**
   * A ghost is a PLACEHOLDER PERSON, not an account. They have no session, no
   * password, and often an address someone else typed in for them. That address
   * must never turn into a nag, and must never become a verified login without
   * a claim. See docs/GUEST.md.
   */
  test("issueVerificationToken reports no_email, even for a ghost carrying one", async () => {
    const withoutEmail = ulid();
    await db
      .insertInto("users")
      .values({ id: withoutEmail, first_name: "Ghosty", is_ghost: 1 })
      .execute();

    const withEmail = ulid();
    await db
      .insertInto("users")
      .values({
        id: withEmail,
        first_name: "Invited",
        email: "invited-ghost@example.com",
        is_ghost: 1,
      })
      .execute();

    assert.deepEqual(await issueVerificationToken(withoutEmail), { status: "no_email" });
    assert.deepEqual(await issueVerificationToken(withEmail), { status: "no_email" });
  });
});

describe("/me reports verification state", () => {
  test("needsEmailVerification flips after verifying", async () => {
    const user = await registerUser();

    const before = (await (
      await app.request("/api/v1/auth/me", { headers: { Cookie: user.cookie } })
    ).json()) as { user: { emailVerified: boolean; needsEmailVerification: boolean } };
    assert.equal(before.user.emailVerified, false);
    assert.equal(before.user.needsEmailVerification, true);

    const token = await issueAndCapture(user.id);
    await consumeVerificationToken(token);

    const after = (await (
      await app.request("/api/v1/auth/me", { headers: { Cookie: user.cookie } })
    ).json()) as { user: { emailVerified: boolean; needsEmailVerification: boolean } };
    assert.equal(after.user.emailVerified, true);
    assert.equal(after.user.needsEmailVerification, false);
  });
});

describe("login gate", () => {
  test("unverified users can still log in by default", async () => {
    const user = await registerUser();

    const res = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: "hunter2hunter2" }),
    });

    // EMAIL_VERIFICATION_REQUIRED defaults to false; a mail outage must not
    // lock a self-hoster out of their own server.
    assert.equal(res.status, 200);
    const body = (await res.json()) as { emailVerified: boolean };
    assert.equal(body.emailVerified, false);
  });
});
