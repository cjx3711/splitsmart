/**
 * Email-first signup: the `emails` table, IP limits, and completing an
 * account from a token. Existing-account verification (the banner / resend
 * path) lives in verification.test.ts.
 *
 * EMAIL_VERIFICATION_REQUIRED defaults to false, so /signup returns verifyUrl
 * and the frontend can finish without a mail provider. The required-on path
 * is exercised by calling startEmailSignup() directly with the flag.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-signup-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";
process.env.APP_ORIGIN = "http://localhost:5545";
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM_ADDRESS;
delete process.env.POSTMARK_SERVER_TOKEN;
delete process.env.POSTMARK_FROM_ADDRESS;
delete process.env.EMAIL_VERIFICATION_REQUIRED;

const { migrate } = await import("../db/migrate.ts");
const { seed } = await import("../db/seed.ts");
const { app } = await import("../server.ts");
const { db } = await import("../db/index.ts");
const {
  startEmailSignup,
  lookupSignupToken,
  tokenFromVerifyUrl,
  SIGNUP_IP_MAX_STARTS,
  purgeExpiredSignupEmails,
} = await import("./signup.ts");
const { generateToken } = await import("../auth/password.ts");

before(() => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

let counter = 0;
function nextEmail(): string {
  return `signup${++counter}@example.com`;
}

async function startSignup(
  email: string,
  ip = "203.0.113.1",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request("/api/v1/auth/signup", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
    },
    body: JSON.stringify({ email }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function tokenFor(email: string, ip?: string): Promise<string> {
  const { status, body } = await startSignup(email, ip);
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(typeof body.verifyUrl, "string");
  return tokenFromVerifyUrl(body.verifyUrl as string);
}

describe("POST /api/v1/auth/signup", () => {
  test("returns a verifyUrl when verification is not required, and writes no user", async () => {
    const email = nextEmail();
    const { status, body } = await startSignup(email, "203.0.113.10");

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.email, email);
    assert.equal(body.delivered, false);
    assert.equal(typeof body.verifyUrl, "string");
    assert.match(body.verifyUrl as string, /\/app\/verify\//);

    const users = await db
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .execute();
    assert.equal(users.length, 0);

    const row = await db
      .selectFrom("emails")
      .select(["email", "requester_ip", "token_hash", "consumed_at"])
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    assert.equal(row.email, email);
    assert.equal(row.requester_ip, "203.0.113.10");
    assert.equal(row.consumed_at, null);
    assert.notEqual(row.token_hash, tokenFromVerifyUrl(body.verifyUrl as string));
  });

  test("takes the leftmost X-Forwarded-For hop", async () => {
    const email = nextEmail();
    const res = await app.request("/api/v1/auth/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "198.51.100.7, 10.0.0.1",
      },
      body: JSON.stringify({ email }),
    });
    assert.equal(res.status, 200);
    const row = await db
      .selectFrom("emails")
      .select("requester_ip")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    assert.equal(row.requester_ip, "198.51.100.7");
  });

  test("409 if that address already has an account", async () => {
    const email = nextEmail();
    const token = await tokenFor(email, "203.0.113.11");
    const created = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password: "hunter2hunter2", name: "Taken" }),
    });
    assert.equal(created.status, 201);

    const { status, body } = await startSignup(email, "203.0.113.12");
    assert.equal(status, 409);
    assert.match(String(body.error), /already exists/i);
  });

  test("rate limits repeats of the same email", async () => {
    const email = nextEmail();
    const first = await startSignup(email, "203.0.113.13");
    assert.equal(first.status, 200);
    const second = await startSignup(email, "203.0.113.14");
    assert.equal(second.status, 429);
    assert.ok(second.body.retryAfterSeconds);
  });

  test("rate limits an IP that starts too many signups", async () => {
    const ip = "198.51.100.99";
    for (let i = 0; i < SIGNUP_IP_MAX_STARTS; i++) {
      const { status, body } = await startSignup(nextEmail(), ip);
      assert.equal(status, 200, `start ${i} should succeed: ${JSON.stringify(body)}`);
    }
    const blocked = await startSignup(nextEmail(), ip);
    assert.equal(blocked.status, 429);
    assert.ok(blocked.body.retryAfterSeconds);
  });

  test("omits verifyUrl when verification is required, and still stores a token", async () => {
    const email = nextEmail();
    const result = await startEmailSignup({
      email,
      ip: "203.0.113.20",
      emailVerificationRequired: true,
    });
    assert.equal(result.status, "started");
    if (result.status !== "started") return;
    assert.equal(result.verifyUrl, null);
    assert.equal(result.delivered, false);

    const row = await db
      .selectFrom("emails")
      .select("token_hash")
      .where("email", "=", email)
      .executeTakeFirst();
    assert.ok(row?.token_hash);
  });

  test("stores next on the row and on the verify URL", async () => {
    const email = nextEmail();
    const res = await app.request("/api/v1/auth/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.60",
      },
      body: JSON.stringify({ email, next: "/claim?link=abc" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verifyUrl: string };
    assert.match(body.verifyUrl, /next=%2Fclaim%3Flink%3Dabc/);

    const token = tokenFromVerifyUrl(body.verifyUrl);
    const verify = await app.request(`/api/v1/auth/verify/${token}`, { method: "POST" });
    assert.equal(verify.status, 200);
    const verified = (await verify.json()) as { next: string };
    assert.equal(verified.next, "/claim?link=abc");
  });

  test("drops an open-redirect next", async () => {
    const email = nextEmail();
    const res = await app.request("/api/v1/auth/signup", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.61",
      },
      body: JSON.stringify({ email, next: "//evil.example" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verifyUrl: string };
    assert.equal(new URL(body.verifyUrl).search, "");
  });
});

describe("POST /api/v1/auth/verify/:token signup", () => {
  test("returns pending_signup and the address, without creating a user", async () => {
    const email = nextEmail();
    const token = await tokenFor(email, "203.0.113.21");

    const res = await app.request(`/api/v1/auth/verify/${token}`, { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      ok: true,
      status: "pending_signup",
      email,
      next: null,
    });

    const users = await db.selectFrom("users").select("id").where("email", "=", email).execute();
    assert.equal(users.length, 0);

    const row = await db
      .selectFrom("emails")
      .select("verified_at")
      .where("email", "=", email)
      .executeTakeFirstOrThrow();
    assert.ok(row.verified_at);
  });

  test("a second click is still pending, not an error", async () => {
    const email = nextEmail();
    const token = await tokenFor(email, "203.0.113.22");
    await lookupSignupToken(token);
    const second = await lookupSignupToken(token);
    assert.deepEqual(second, { status: "pending", email, nextPath: null });
  });

  test("rejects an expired signup token", async () => {
    const email = nextEmail();
    const token = await tokenFor(email, "203.0.113.23");
    await db
      .updateTable("emails")
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where("email", "=", email)
      .where("consumed_at", "is", null)
      .execute();

    const res = await app.request(`/api/v1/auth/verify/${token}`, { method: "POST" });
    assert.equal(res.status, 410);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "expired");
  });

  test("a new start invalidates the previous token", async () => {
    const email = nextEmail();
    const first = await tokenFor(email, "203.0.113.24");
    await db
      .updateTable("emails")
      .set({ created_at: "2020-01-01 00:00:00" })
      .where("email", "=", email)
      .execute();
    await tokenFor(email, "203.0.113.25");

    const result = await lookupSignupToken(first);
    assert.equal(result.status, "expired");
  });
});

describe("POST /api/v1/auth/register", () => {
  test("creates a verified account from the signup token and sets a session", async () => {
    const email = nextEmail();
    const token = await tokenFor(email, "203.0.113.30");

    const res = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token,
        password: "hunter2hunter2",
        name: "Alex Chen",
        nickname: "Alex",
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      user: {
        email: string;
        name: string;
        nickname: string;
        emailVerified: boolean;
        needsEmailVerification: boolean;
      };
      emailVerified: boolean;
    };
    assert.equal(body.user.email, email);
    assert.equal(body.user.name, "Alex Chen");
    assert.equal(body.user.nickname, "Alex");
    assert.equal(body.user.emailVerified, true);
    assert.equal(body.user.needsEmailVerification, false);
    assert.equal(body.emailVerified, true);
    assert.ok(res.headers.get("set-cookie")?.includes("splitsmart_session"));

    const row = await db
      .selectFrom("emails")
      .select(["consumed_at", "user_id"])
      .where("email", "=", email)
      .orderBy("created_at", "desc")
      .executeTakeFirstOrThrow();
    assert.ok(row.consumed_at);
    assert.ok(row.user_id);
  });

  test("refuses a missing or unknown token", async () => {
    const missing = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "hunter2hunter2", name: "No Token" }),
    });
    assert.equal(missing.status, 400);

    const unknown = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: generateToken(32),
        password: "hunter2hunter2",
        name: "Ghost",
      }),
    });
    assert.equal(unknown.status, 404);
  });

  test("a consumed token cannot register a second account", async () => {
    const email = nextEmail();
    const token = await tokenFor(email, "203.0.113.31");
    const first = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password: "hunter2hunter2", name: "Once" }),
    });
    assert.equal(first.status, 201);

    const second = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password: "hunter2hunter2", name: "Twice" }),
    });
    assert.equal(second.status, 404);

    const verify = await app.request(`/api/v1/auth/verify/${token}`, { method: "POST" });
    assert.equal(verify.status, 410);
  });

  test("does not send a password in the signup row", async () => {
    const email = nextEmail();
    await tokenFor(email, "203.0.113.32");
    const row = await db.selectFrom("emails").selectAll().where("email", "=", email).executeTakeFirstOrThrow();
    assert.equal("password_hash" in row, false);
    assert.equal(row.user_id, null);
  });
});

describe("purgeExpiredSignupEmails", () => {
  test("drops pending expired rows and keeps consumed ones", async () => {
    const pending = nextEmail();
    const consumed = nextEmail();
    await tokenFor(pending, "203.0.113.40");
    const token = await tokenFor(consumed, "203.0.113.41");
    const created = await app.request("/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password: "hunter2hunter2", name: "Kept" }),
    });
    assert.equal(created.status, 201);

    await db
      .updateTable("emails")
      .set({ expires_at: new Date(Date.now() - 1000).toISOString() })
      .where("email", "in", [pending, consumed])
      .execute();

    const dropped = await purgeExpiredSignupEmails();
    assert.ok(dropped >= 1);

    const leftover = await db
      .selectFrom("emails")
      .select("email")
      .where("email", "in", [pending, consumed])
      .execute();
    assert.deepEqual(
      leftover.map((r) => r.email).sort(),
      [consumed],
    );
  });
});
