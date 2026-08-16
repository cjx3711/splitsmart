/**
 * Sessions and API tokens.
 *
 * Two independent authentication paths, deliberately kept apart:
 *
 *   Sessions   — httpOnly cookie, used by the web UI, expires, rotates.
 *   API tokens — bearer header, used by the Splitwise-compatible API and by
 *                external tools like splitwise-to-toshl. Long-lived, revocable.
 *
 * Neither stores the secret in plaintext; only SHA-256 digests are persisted.
 */
import { db } from "../db/index.ts";
import { generateToken, hashToken } from "./password.ts";
import { randomUUID } from "node:crypto";

export const SESSION_COOKIE = "splitsmart_session";
const SESSION_TTL_DAYS = 30;

export interface AuthenticatedUser {
  id: number;
  firstName: string;
  lastName: string | null;
  email: string | null;
  isGhost: boolean;
  defaultCurrency: string;
}

export async function createSession(
  userId: number,
  userAgent?: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 86_400_000);

  await db
    .insertInto("sessions")
    .values({
      id: randomUUID(),
      token_hash: hashToken(token),
      user_id: userId,
      user_agent: userAgent ?? null,
      expires_at: expiresAt.toISOString(),
    })
    .execute();

  return { token, expiresAt };
}

export async function resolveSession(token: string): Promise<AuthenticatedUser | null> {
  const row = await db
    .selectFrom("sessions")
    .innerJoin("users", "users.id", "sessions.user_id")
    .select([
      "users.id as id",
      "users.first_name as firstName",
      "users.last_name as lastName",
      "users.email as email",
      "users.is_ghost as isGhost",
      "users.default_currency as defaultCurrency",
      "sessions.id as sessionId",
      "sessions.expires_at as expiresAt",
    ])
    .where("sessions.token_hash", "=", hashToken(token))
    .where("users.deleted_at", "is", null)
    .executeTakeFirst();

  if (!row) return null;

  if (new Date(row.expiresAt) < new Date()) {
    await db.deleteFrom("sessions").where("id", "=", row.sessionId).execute();
    return null;
  }

  // Best-effort activity tracking; never block the request on it.
  void db
    .updateTable("sessions")
    .set({ last_seen_at: new Date().toISOString() })
    .where("id", "=", row.sessionId)
    .execute()
    .catch(() => {});

  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    isGhost: row.isGhost === 1,
    defaultCurrency: row.defaultCurrency,
  };
}

export async function destroySession(token: string): Promise<void> {
  await db.deleteFrom("sessions").where("token_hash", "=", hashToken(token)).execute();
}

/** Housekeeping — safe to call on boot and on a timer. */
export async function purgeExpiredSessions(): Promise<number> {
  const result = await db
    .deleteFrom("sessions")
    .where("expires_at", "<", new Date().toISOString())
    .executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}

// ---------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------

/**
 * Mints an API token. The plaintext is returned ONCE and never recoverable —
 * only its hash is stored, so a lost token must be revoked and reissued.
 */
export async function createApiToken(
  userId: number,
  name: string,
): Promise<{ token: string; id: string }> {
  const token = generateToken(32);
  const id = randomUUID();

  await db
    .insertInto("api_tokens")
    .values({ id, token_hash: hashToken(token), user_id: userId, name })
    .execute();

  return { token, id };
}

export async function resolveApiToken(token: string): Promise<AuthenticatedUser | null> {
  const row = await db
    .selectFrom("api_tokens")
    .innerJoin("users", "users.id", "api_tokens.user_id")
    .select([
      "users.id as id",
      "users.first_name as firstName",
      "users.last_name as lastName",
      "users.email as email",
      "users.is_ghost as isGhost",
      "users.default_currency as defaultCurrency",
      "api_tokens.id as tokenId",
      "api_tokens.revoked_at as revokedAt",
      "api_tokens.expires_at as expiresAt",
    ])
    .where("api_tokens.token_hash", "=", hashToken(token))
    .where("users.deleted_at", "is", null)
    .executeTakeFirst();

  if (!row) return null;
  if (row.revokedAt) return null;
  if (row.expiresAt && new Date(row.expiresAt) < new Date()) return null;

  void db
    .updateTable("api_tokens")
    .set({ last_used_at: new Date().toISOString() })
    .where("id", "=", row.tokenId)
    .execute()
    .catch(() => {});

  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    isGhost: row.isGhost === 1,
    defaultCurrency: row.defaultCurrency,
  };
}

export async function revokeApiToken(id: string, userId: number): Promise<void> {
  await db
    .updateTable("api_tokens")
    .set({ revoked_at: new Date().toISOString() })
    .where("id", "=", id)
    .where("user_id", "=", userId)
    .execute();
}
