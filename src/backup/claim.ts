/**
 * The atomic day claim.
 *
 * Four invariants hold this together:
 *
 * 1. THE CLAIM IS ONE BARE `INSERT`. No `BEGIN`. A single statement is
 *    atomic; wrapping it in a deferred transaction would take a read lock
 *    and upgrade on write — producing SQLITE_BUSY instead of a clean
 *    constraint violation.
 * 2. SUCCESS KEEPS `claim_key` SET. Only `failed` and `abandoned` release
 *    it to NULL, so "don't back up twice in one day" is enforced by a
 *    UNIQUE index rather than by the due-check being correct.
 * 3. THE DUE-CHECK IS ADVISORY; THE INSERT IS THE SOLE ARBITER. Two
 *    processes may both decide a run is due — fine, one gets
 *    SQLITE_CONSTRAINT and stands down.
 * 4. MANUAL RUNS NEVER FIGHT THE CLAIM. A forced manual run inserts
 *    `claim_key: null`: it is history, it does not own the day.
 */

import { sql, type SqlBool } from "kysely";
import { db } from "../db/index.ts";
import { scrubSecrets } from "./config.ts";
import { isSqliteUniqueViolation } from "./sqlite-errors.ts";

export type BackupTrigger = "scheduled" | "manual";

export type ClaimResult =
  | { kind: "claimed"; id: number; attempt: number }
  | { kind: "already_claimed" }
  | { kind: "transient"; error: unknown };

export type ClaimOptions = {
  attempt: number;
  trigger: BackupTrigger;
  /**
   * `true` inserts a history row that does not own the day
   * (`claim_key: null`), for a forced manual run alongside whatever else
   * is happening.
   */
  force?: boolean;
};

export type BackupSuccess = {
  isWeekly: boolean;
  dailyKey: string;
  weeklyKey: string | null;
  sourceBytes: number;
  snapshotBytes: number;
  compressedBytes: number;
  startedAtMs: number;
};

const SUCCESS_UPDATE_ATTEMPTS = 3;
const SUCCESS_UPDATE_BACKOFF_MS = 500;

/** Truncated so a pathological SDK error cannot bloat the row. */
function formatError(err: unknown): string {
  const raw =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : typeof err === "string"
        ? err
        : JSON.stringify(err);
  return scrubSecrets(raw ?? "unknown error").slice(0, 2000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Give up on a run whose heartbeat has gone quiet and release its day so
 * it can be retried. SIGKILL is the expected shutdown path in production,
 * so this — not the shutdown hook — is the primary recovery mechanism.
 */
export async function releaseStaleClaim(
  backupDate: string,
  staleMinutes: number,
): Promise<void> {
  await db
    .updateTable("database_backups")
    .set({
      status: "abandoned",
      claim_key: null,
      finished_at: sql`datetime('now')`,
      error_message: `Abandoned: no heartbeat for over ${staleMinutes} minutes`,
    })
    .where("claim_key", "=", backupDate)
    .where("status", "=", "running")
    .where(
      sql<SqlBool>`COALESCE(heartbeat_at, started_at) < datetime('now', ${`-${staleMinutes} minutes`})`,
    )
    .execute();
}

/**
 * Try to become the owner of `backupDate`. Exactly one caller can win;
 * everyone else gets `already_claimed` from the UNIQUE index on
 * `claim_key`.
 */
export async function claimDay(
  backupDate: string,
  options: ClaimOptions,
): Promise<ClaimResult> {
  const claimKey = options.force ? null : backupDate;

  try {
    const inserted = await db
      .insertInto("database_backups")
      .values({
        backup_date: backupDate,
        claim_key: claimKey,
        trigger: options.trigger,
        status: "running",
        attempt: options.attempt,
        is_weekly: 0,
        heartbeat_at: sql`datetime('now')`,
      })
      .returning("id")
      .executeTakeFirst();

    if (inserted && typeof inserted.id === "number") {
      return { kind: "claimed", id: inserted.id, attempt: options.attempt };
    }

    const fallback = await db
      .selectFrom("database_backups")
      .select("id")
      .where("backup_date", "=", backupDate)
      .where("status", "=", "running")
      .orderBy("id", "desc")
      .executeTakeFirst();
    if (!fallback) {
      return {
        kind: "transient",
        error: new Error("claim insert succeeded but the row could not be read back"),
      };
    }
    return { kind: "claimed", id: fallback.id, attempt: options.attempt };
  } catch (error) {
    if (isSqliteUniqueViolation(error, "database_backups.claim_key")) {
      return { kind: "already_claimed" };
    }
    return { kind: "transient", error };
  }
}

/** Keep the run visibly alive. Called roughly every 60s while a snapshot is in flight. */
export async function touchHeartbeat(id: number): Promise<void> {
  await db
    .updateTable("database_backups")
    .set({ heartbeat_at: sql`datetime('now')` })
    .where("id", "=", id)
    .where("status", "=", "running")
    .execute();
}

/**
 * Mark the run failed and RELEASE the day, so it can be retried — subject
 * to the retry gate in `due.ts`, which is what stops a permanently broken
 * backup from vacuuming the database every tick.
 */
export async function releaseOnFailure(
  id: number,
  err: unknown,
  startedAtMs: number,
): Promise<void> {
  await db
    .updateTable("database_backups")
    .set({
      status: "failed",
      claim_key: null,
      finished_at: sql`datetime('now')`,
      duration_ms: Date.now() - startedAtMs,
      error_message: formatError(err),
    })
    .where("id", "=", id)
    .execute();
}

/**
 * Record a completed run, KEEPING `claim_key` so the day stays owned.
 *
 * Retried, because the interesting failure path is "upload succeeded but
 * the success UPDATE failed" (`SQLITE_BUSY` being the likely cause).
 * Returns false when even the retries fail: the object is in S3 and
 * correct, but the row still says `running`, so the next tick will
 * abandon it and re-run the day — which overwrites the same key, because
 * every key is a pure function of `backup_date`.
 */
export async function recordSuccess(
  id: number,
  result: BackupSuccess,
): Promise<boolean> {
  for (let attempt = 1; attempt <= SUCCESS_UPDATE_ATTEMPTS; attempt += 1) {
    try {
      await db
        .updateTable("database_backups")
        .set({
          status: "success",
          finished_at: sql`datetime('now')`,
          is_weekly: result.isWeekly ? 1 : 0,
          daily_key: result.dailyKey,
          weekly_key: result.weeklyKey,
          source_bytes: result.sourceBytes,
          snapshot_bytes: result.snapshotBytes,
          compressed_bytes: result.compressedBytes,
          duration_ms: Date.now() - result.startedAtMs,
        })
        .where("id", "=", id)
        .execute();
      return true;
    } catch (error) {
      if (attempt === SUCCESS_UPDATE_ATTEMPTS) {
        console.error(
          `[backup] run ${id} uploaded ${result.dailyKey} but the success update failed ` +
            `after ${SUCCESS_UPDATE_ATTEMPTS} attempts; the object IS in the bucket. ` +
            "The next tick will abandon this row and re-run the day, overwriting the same key.",
          error,
        );
        return false;
      }
      await sleep(SUCCESS_UPDATE_BACKOFF_MS * attempt);
    }
  }
  return false;
}

/**
 * Pruning happens after success is recorded and must never fail the
 * backup, so the count is written separately and its own failure is only
 * logged.
 */
export async function recordPrunedCount(
  id: number,
  prunedObjectCount: number,
): Promise<void> {
  await db
    .updateTable("database_backups")
    .set({ pruned_object_count: prunedObjectCount })
    .where("id", "=", id)
    .execute();
}
