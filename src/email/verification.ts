/**
 * Email verification: issuing, sending, and consuming tokens.
 *
 * Flow:
 *   1. register (or claim, or change email) -> issueVerificationToken()
 *   2. user clicks the link -> consumeVerificationToken()
 *   3. users.email_verified_at is set
 *
 * Enforcement lives in the auth routes, not here. By default verification is
 * ADVISORY: the account works, the UI shows a banner. Set
 * EMAIL_VERIFICATION_REQUIRED=true to block login until verified; and read the
 * warning on `scripts/verify-user.ts` before you do, because a broken Postmark
 * config plus required verification locks you out of your own server.
 */
import { ulid } from "../domain/ulid.ts";
import { db } from "../db/index.ts";
import { env } from "../env.ts";
import { generateToken, hashToken } from "../auth/password.ts";
import { sendEmail } from "./postmark.ts";
import { verificationEmail } from "./templates.ts";

const TOKEN_TTL_HOURS = 24;

/**
 * Minimum gap between verification emails to one user.
 *
 * Prevents someone hammering the resend endpoint to use your Postmark quota as
 * a mail cannon aimed at a third party.
 */
const RESEND_COOLDOWN_MS = 60_000;

export type IssueOutcome =
  | { status: "sent"; delivered: boolean }
  | { status: "cooldown"; retryAfterSeconds: number }
  | { status: "already_verified" }
  | { status: "no_email" };

/**
 * Issues a verification token and emails it.
 *
 * Invalidates any outstanding tokens for this user first, so only the most
 * recent link works. Without that, an old link recovered from a mailbox stays
 * live for its full 24 hours.
 */
export async function issueVerificationToken(userId: string): Promise<IssueOutcome> {
  const user = await db
    .selectFrom("users")
    .select(["id", "email", "first_name", "email_verified_at", "is_ghost"])
    .where("id", "=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  // Ghosts have no address; there is nothing to verify.
  if (!user || !user.email || user.is_ghost === 1) return { status: "no_email" };
  if (user.email_verified_at) return { status: "already_verified" };

  const recent = await db
    .selectFrom("email_tokens")
    .select(["created_at"])
    .where("user_id", "=", userId)
    .where("purpose", "=", "verify_email")
    .orderBy("created_at", "desc")
    .executeTakeFirst();

  if (recent) {
    const elapsed = Date.now() - new Date(`${recent.created_at.replace(" ", "T")}Z`).getTime();
    if (elapsed >= 0 && elapsed < RESEND_COOLDOWN_MS) {
      return {
        status: "cooldown",
        retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - elapsed) / 1000),
      };
    }
  }

  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 3_600_000);

  await db.transaction().execute(async (trx) => {
    // Supersede outstanding links for this purpose.
    await trx
      .updateTable("email_tokens")
      .set({ used_at: new Date().toISOString() })
      .where("user_id", "=", userId)
      .where("purpose", "=", "verify_email")
      .where("used_at", "is", null)
      .execute();

    await trx
      .insertInto("email_tokens")
      .values({
        id: ulid(),
        token_hash: hashToken(token),
        user_id: userId,
        purpose: "verify_email",
        email: user.email!,
        expires_at: expiresAt.toISOString(),
      })
      .execute();
  });

  const message = verificationEmail({
    firstName: user.first_name,
    // Under /app: the verification screen is part of the logged-in shell.
    // See docs/GUEST.md, "Two shells".
    verifyUrl: `${env.APP_ORIGIN}/app/verify/${token}`,
    expiresInHours: TOKEN_TTL_HOURS,
  });

  const result = await sendEmail({ to: user.email, ...message });
  return { status: "sent", delivered: result.delivered };
}

export type ConsumeOutcome =
  | { status: "verified"; userId: string }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "already_used" }
  | { status: "email_changed" };

/**
 * Consumes a verification token and marks the address verified.
 *
 * Distinguishes failure modes for the UI's benefit, but every one of them is
 * safe to show: none reveals whether an account exists, because you cannot get
 * here without already holding a token.
 */
export async function consumeVerificationToken(token: string): Promise<ConsumeOutcome> {
  const row = await db
    .selectFrom("email_tokens")
    .innerJoin("users", "users.id", "email_tokens.user_id")
    .select([
      "email_tokens.id as tokenId",
      "email_tokens.user_id as userId",
      "email_tokens.email as tokenEmail",
      "email_tokens.expires_at as expiresAt",
      "email_tokens.used_at as usedAt",
      "users.email as currentEmail",
      "users.email_verified_at as verifiedAt",
    ])
    .where("email_tokens.token_hash", "=", hashToken(token))
    .where("email_tokens.purpose", "=", "verify_email")
    .where("users.deleted_at", "is", null)
    .executeTakeFirst();

  if (!row) return { status: "invalid" };

  // Already-verified is reported as success: clicking the link twice, or having
  // a mail scanner prefetch it, should not look like an error to the user.
  if (row.verifiedAt) return { status: "verified", userId: row.userId };

  if (row.usedAt) return { status: "already_used" };
  if (new Date(row.expiresAt) < new Date()) return { status: "expired" };

  // The address changed after this token was issued. See the email_tokens
  // table comment in migrations/001_initial_schema.sql for why this check
  // exists.
  if (row.tokenEmail !== row.currentEmail) return { status: "email_changed" };

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("email_tokens")
      .set({ used_at: new Date().toISOString() })
      .where("id", "=", row.tokenId)
      .execute();

    await trx
      .updateTable("users")
      .set({ email_verified_at: new Date().toISOString() })
      .where("id", "=", row.userId)
      .execute();
  });

  return { status: "verified", userId: row.userId };
}

/** Housekeeping: safe to call on boot and on a timer. */
export async function purgeExpiredEmailTokens(): Promise<number> {
  const result = await db
    .deleteFrom("email_tokens")
    .where("expires_at", "<", new Date().toISOString())
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
