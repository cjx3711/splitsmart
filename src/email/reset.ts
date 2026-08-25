/**
 * Password reset for an existing account, using `email_tokens` with
 * purpose `reset_password`. The CHECK on that table has allowed this since
 * the first migration; this module is the routes' implementation.
 *
 * Flow:
 *   1. POST /auth/password/forgot { email } -> issuePasswordReset()
 *   2. User opens /app/reset/:token (from the inbox, or the server log when
 *      no mail provider is configured)
 *   3. POST /auth/password/reset/:token { password } consumes the row, writes
 *      the new hash, ends other web sessions, and opens a new one
 *
 * The request-reset response never says whether the address has an account.
 * Completing a reset is inbox proof, so an unverified address becomes
 * verified — the same evidence `consumeVerificationToken` records.
 *
 * Ghosts have no login and no `users.email`; they cannot reset.
 */
import { ulid } from "../domain/ulid.ts";
import { db } from "../db/index.ts";
import { env } from "../env.ts";
import { generateToken, hashToken } from "../auth/password.ts";
import { destroySessionsForUser } from "../auth/session.ts";
import { sendTrackedEmail } from "./sends.ts";
import { resetPasswordEmail } from "./templates.ts";
import { displayName } from "../domain/person.ts";

const TOKEN_TTL_HOURS = 24;

/**
 * Minimum gap between reset emails to one account.
 *
 * Same figure as verification resend: stops someone using your mail quota
 * as a cannon aimed at a third party.
 */
const RESET_COOLDOWN_MS = 60_000;

export type IssueResetOutcome =
  | { status: "sent"; delivered: boolean }
  | { status: "cooldown" }
  | { status: "no_account" };

export type LookupResetOutcome =
  | { status: "pending"; email: string }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "already_used" }
  | { status: "email_changed" };

export type CompleteResetOutcome =
  | { status: "reset"; userId: string }
  | { status: "invalid" }
  | { status: "expired" }
  | { status: "already_used" }
  | { status: "email_changed" };

/**
 * Issues a reset token and emails it, or no-ops when the address has no
 * login. Callers must treat every outcome as success on the wire.
 *
 * Invalidates any outstanding reset tokens for this user first, so only the
 * most recent link works.
 */
export async function issuePasswordReset(email: string): Promise<IssueResetOutcome> {
  const user = await db
    .selectFrom("users")
    .select(["id", "email", "name", "nickname", "is_ghost"])
    .where("email", "=", email.trim())
    .where("is_ghost", "=", 0)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  // Ghosts and unknown addresses take the same path: do nothing. The route
  // returns the same JSON either way so the wording cannot enumerate accounts.
  if (!user || !user.email) return { status: "no_account" };

  const recent = await db
    .selectFrom("email_tokens")
    .select(["created_at"])
    .where("user_id", "=", user.id)
    .where("purpose", "=", "reset_password")
    .orderBy("created_at", "desc")
    .executeTakeFirst();

  if (recent) {
    const elapsed = Date.now() - new Date(`${recent.created_at.replace(" ", "T")}Z`).getTime();
    if (elapsed >= 0 && elapsed < RESET_COOLDOWN_MS) {
      return { status: "cooldown" };
    }
  }

  const token = generateToken(32);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 3_600_000);

  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("email_tokens")
      .set({ used_at: new Date().toISOString() })
      .where("user_id", "=", user.id)
      .where("purpose", "=", "reset_password")
      .where("used_at", "is", null)
      .execute();

    await trx
      .insertInto("email_tokens")
      .values({
        id: ulid(),
        token_hash: hashToken(token),
        user_id: user.id,
        purpose: "reset_password",
        email: user.email!,
        expires_at: expiresAt.toISOString(),
      })
      .execute();
  });

  const message = resetPasswordEmail({
    name: displayName(user),
    resetUrl: `${env.APP_ORIGIN}/app/reset/${token}`,
    expiresInHours: TOKEN_TTL_HOURS,
  });

  const result = await sendTrackedEmail({
    type: "reset",
    message: { to: user.email, ...message },
    actorUserId: user.id,
    subjectUserId: user.id,
  });
  return { status: "sent", delivered: result.ok && result.delivered };
}

/**
 * Opens a reset link so the form can show which address it will change.
 * Does not consume the token; completing the form does. Mail scanners
 * prefetch this; a second call is still pending, not an error.
 */
export async function lookupPasswordReset(token: string): Promise<LookupResetOutcome> {
  const row = await loadResetToken(token);
  if (!row) return { status: "invalid" };
  if (row.usedAt) return { status: "already_used" };
  if (new Date(row.expiresAt) < new Date()) return { status: "expired" };
  if (row.tokenEmail !== row.currentEmail) return { status: "email_changed" };
  return { status: "pending", email: row.tokenEmail };
}

/**
 * Consumes a reset token, writes the new password hash, marks the address
 * verified, and ends every web session for the account.
 *
 * `passwordHash` is already scrypt'd by the caller: hashing is slow and
 * does not belong inside the SQLite transaction.
 */
export async function completePasswordReset(
  token: string,
  passwordHash: string,
): Promise<CompleteResetOutcome> {
  const row = await loadResetToken(token);
  if (!row) return { status: "invalid" };
  if (row.usedAt) return { status: "already_used" };
  if (new Date(row.expiresAt) < new Date()) return { status: "expired" };
  if (row.tokenEmail !== row.currentEmail) return { status: "email_changed" };

  const now = new Date().toISOString();
  const updatedAt = now.slice(0, 19).replace("T", " ");

  const claimed = await db.transaction().execute(async (trx) => {
    const used = await trx
      .updateTable("email_tokens")
      .set({ used_at: now })
      .where("id", "=", row.tokenId)
      .where("used_at", "is", null)
      .executeTakeFirst();

    if (Number(used.numUpdatedRows ?? 0) === 0) return false;

    await trx
      .updateTable("users")
      .set({
        password_hash: passwordHash,
        email_verified_at: row.verifiedAt ?? now,
        updated_at: updatedAt,
      })
      .where("id", "=", row.userId)
      .execute();

    return true;
  });

  if (!claimed) return { status: "already_used" };

  await destroySessionsForUser(row.userId);
  return { status: "reset", userId: row.userId };
}

async function loadResetToken(token: string): Promise<{
  tokenId: string;
  userId: string;
  tokenEmail: string;
  expiresAt: string;
  usedAt: string | null;
  currentEmail: string | null;
  verifiedAt: string | null;
} | null> {
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
    .where("email_tokens.purpose", "=", "reset_password")
    .where("users.deleted_at", "is", null)
    .where("users.is_ghost", "=", 0)
    .executeTakeFirst();

  return row ?? null;
}
