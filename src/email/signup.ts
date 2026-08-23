/**
 * Email-first signup: prove an address, then create the user.
 *
 * Flow:
 *   1. POST /auth/signup { email } -> startEmailSignup()
 *   2. User opens /app/verify/:token (from the API response when
 *      EMAIL_VERIFICATION_REQUIRED is off, or from their inbox when it is on)
 *   3. POST /auth/register { token, name, password } consumes the row and
 *      inserts the user
 *
 * The `emails` table holds the pending proof. users.email is still the login
 * unique index; nothing here writes a user.
 *
 * EMAIL_VERIFICATION_REQUIRED controls whether the token is returned to the
 * client (so a box with no mail provider can still finish signup) or only
 * emailed. Holding the token is the proof either way.
 */
import type { Context } from "hono";
import { ulid } from "../domain/ulid.ts";
import { db, type DB } from "../db/index.ts";
import { env } from "../env.ts";
import { generateToken, hashToken } from "../auth/password.ts";
import { sendEmail } from "./send.ts";
import { signupEmail } from "./templates.ts";

export const SIGNUP_TOKEN_TTL_HOURS = 24;
export const SIGNUP_EMAIL_COOLDOWN_MS = 60_000;
export const SIGNUP_IP_WINDOW_MS = 60 * 60 * 1000;
export const SIGNUP_IP_MAX_STARTS = 20;

const MAX_IP_LENGTH = 64;

export type StartSignupOutcome =
  | { status: "started"; delivered: boolean; verifyUrl: string | null }
  | { status: "exists" }
  | { status: "cooldown"; retryAfterSeconds: number }
  | { status: "ip_limited"; retryAfterSeconds: number };

export type LookupSignupOutcome =
  | { status: "pending"; email: string; nextPath: string | null }
  | { status: "expired" }
  | { status: "already_used" }
  | { status: "invalid" };

/**
 * Client address for rate limits.
 *
 * Prefers the leftmost X-Forwarded-For hop (what a reverse proxy should set
 * to the original client), then X-Real-IP, then the Node socket when the
 * server accepted the connection itself. Truncated so a garbage header cannot
 * become an unbounded row.
 */
export function requestIp(c: Context): string | null {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, MAX_IP_LENGTH);
  }
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real.slice(0, MAX_IP_LENGTH);

  const incoming = (
    c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  )?.incoming?.socket?.remoteAddress?.trim();
  if (incoming) return incoming.slice(0, MAX_IP_LENGTH);

  return null;
}

export function verifyUrlForToken(token: string, nextPath: string | null = null): string {
  const url = `${env.APP_ORIGIN}/app/verify/${token}`;
  if (!nextPath) return url;
  return `${url}?next=${encodeURIComponent(nextPath)}`;
}

/** In-app paths only. Same rule the login screen uses for `?next=`. */
export function safeNextPath(next: string | null | undefined): string | null {
  if (!next) return null;
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  if (next.length > 2000) return null;
  return next;
}

export function tokenFromVerifyUrl(verifyUrl: string): string {
  try {
    const parts = new URL(verifyUrl).pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  } catch {
    return "";
  }
}

function sqliteNowMinus(ms: number): string {
  return new Date(Date.now() - ms).toISOString().slice(0, 19).replace("T", " ");
}

function elapsedMs(createdAt: string): number {
  return Date.now() - new Date(`${createdAt.replace(" ", "T")}Z`).getTime();
}

/**
 * Issues a signup token for `email`.
 *
 * Invalidates any outstanding (unconsumed) tokens for the same address first,
 * so only the most recent link works. Does not send mail when verification is
 * not required: the caller puts `verifyUrl` on the wire instead, which is how
 * local/dev completes the flow with no provider. When verification IS
 * required the URL is emailed and omitted from the return value.
 */
export async function startEmailSignup(input: {
  email: string;
  ip: string | null;
  emailVerificationRequired: boolean;
  nextPath?: string | null;
}): Promise<StartSignupOutcome> {
  const email = input.email.trim();
  const nextPath = safeNextPath(input.nextPath);

  const existing = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", email)
    .where("is_ghost", "=", 0)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  if (existing) return { status: "exists" };

  if (input.ip) {
    const recentFromIp = await db
      .selectFrom("emails")
      .select("created_at")
      .where("requester_ip", "=", input.ip)
      .where("created_at", ">=", sqliteNowMinus(SIGNUP_IP_WINDOW_MS))
      .orderBy("created_at", "asc")
      .execute();

    if (recentFromIp.length >= SIGNUP_IP_MAX_STARTS) {
      const oldest = recentFromIp[0]!.created_at;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((SIGNUP_IP_WINDOW_MS - elapsedMs(oldest)) / 1000),
      );
      return { status: "ip_limited", retryAfterSeconds };
    }
  }

  const recentForEmail = await db
    .selectFrom("emails")
    .select("created_at")
    .where("email", "=", email)
    .orderBy("created_at", "desc")
    .executeTakeFirst();

  if (recentForEmail) {
    const elapsed = elapsedMs(recentForEmail.created_at);
    if (elapsed >= 0 && elapsed < SIGNUP_EMAIL_COOLDOWN_MS) {
      return {
        status: "cooldown",
        retryAfterSeconds: Math.ceil((SIGNUP_EMAIL_COOLDOWN_MS - elapsed) / 1000),
      };
    }
  }

  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + SIGNUP_TOKEN_TTL_HOURS * 3_600_000);
  const verifyUrl = verifyUrlForToken(token, nextPath);

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("emails")
      .set({
        // Superseding an unused link. The CHECK forbids consumed_at without
        // a user_id, so expire it instead: lookup reports "expired" rather
        // than handing out a dead token.
        expires_at: new Date(0).toISOString(),
      })
      .where("email", "=", email)
      .where("consumed_at", "is", null)
      .execute();

    await trx
      .insertInto("emails")
      .values({
        id: ulid(),
        email,
        token_hash: hashToken(token),
        requester_ip: input.ip,
        next_path: nextPath,
        expires_at: expiresAt.toISOString(),
      })
      .execute();
  });

  let delivered = false;
  if (input.emailVerificationRequired) {
    const result = await sendEmail({ to: email, ...signupEmail({ verifyUrl, expiresInHours: SIGNUP_TOKEN_TTL_HOURS }) });
    delivered = result.delivered;
  }

  return {
    status: "started",
    delivered,
    verifyUrl: input.emailVerificationRequired ? null : verifyUrl,
  };
}

/**
 * Opens a signup link: records that it was seen, returns the address so the
 * complete-account form can show it. Does not consume the token; register does.
 *
 * Mail scanners prefetch this. A second call is still pending, not an error.
 */
export async function lookupSignupToken(token: string): Promise<LookupSignupOutcome> {
  const row = await db
    .selectFrom("emails")
    .select(["id", "email", "expires_at", "consumed_at", "verified_at", "next_path"])
    .where("token_hash", "=", hashToken(token))
    .executeTakeFirst();

  if (!row) return { status: "invalid" };
  if (row.consumed_at) return { status: "already_used" };
  if (new Date(row.expires_at) < new Date()) return { status: "expired" };

  if (!row.verified_at) {
    await db
      .updateTable("emails")
      .set({ verified_at: new Date().toISOString() })
      .where("id", "=", row.id)
      .where("verified_at", "is", null)
      .execute();
  }

  return { status: "pending", email: row.email, nextPath: row.next_path };
}

/**
 * Atomically claims a live signup token inside the register transaction.
 *
 * Returns the address to copy onto the new user, or null if the token is
 * missing, expired, or already consumed. The caller inserts the user then
 * passes its id to `attachSignupUser`.
 */
export async function takeSignupForRegister(
  trx: DB,
  token: string,
): Promise<{ id: string; email: string } | null> {
  const row = await trx
    .selectFrom("emails")
    .select(["id", "email", "expires_at", "consumed_at"])
    .where("token_hash", "=", hashToken(token))
    .executeTakeFirst();

  if (!row || row.consumed_at) return null;
  if (new Date(row.expires_at) < new Date()) return null;

  return { id: row.id, email: row.email };
}

export async function attachSignupUser(
  trx: DB,
  signupId: string,
  userId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await trx
    .updateTable("emails")
    .set({
      consumed_at: now,
      verified_at: now,
      user_id: userId,
    })
    .where("id", "=", signupId)
    .where("consumed_at", "is", null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/** Housekeeping: drop pending rows whose link can no longer be used. */
export async function purgeExpiredSignupEmails(): Promise<number> {
  const result = await db
    .deleteFrom("emails")
    .where("expires_at", "<", new Date().toISOString())
    .where("consumed_at", "is", null)
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
