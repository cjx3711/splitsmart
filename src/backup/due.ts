/**
 * "Is a backup due right now?" — advisory only. The INSERT in `claim.ts`
 * is the sole arbiter of who actually runs, so two processes both
 * answering "yes" is harmless.
 */

import { sql, type SqlBool } from "kysely";
import { db } from "../db/index.ts";
import type { BackupSettings } from "./config.ts";
import { releaseStaleClaim } from "./claim.ts";
import { shiftDate, utcDate, utcHour } from "./time.ts";

export type DueDecision =
  | {
      due: true;
      backupDate: string;
      attempt: number;
      reason: "scheduled" | "catch_up";
    }
  | {
      due: false;
      backupDate: string;
      reason:
        | "day_claimed"
        | "attempts_exhausted"
        | "retry_backoff"
        | "before_hour";
      detail?: string;
    };

export async function evaluateDue(
  config: BackupSettings,
  now: Date,
): Promise<DueDecision> {
  const today = utcDate(now);
  const hour = utcHour(now);

  await releaseStaleClaim(today, config.staleAfterMinutes);

  const claimed = await db
    .selectFrom("database_backups")
    .select("id")
    .where("claim_key", "=", today)
    .limit(1)
    .executeTakeFirst();
  if (claimed) {
    return { due: false, backupDate: today, reason: "day_claimed" };
  }

  // The retry gate is load-bearing. Without it a permanently failing
  // backup (bad credentials, full disk) retries every tick — 96 times a
  // day, each doing a full database vacuum. That is a self-inflicted
  // outage.
  //
  // Manual rows count towards the budget on purpose: a manual failure is
  // evidence the environment is broken, and the scheduler should back
  // off too.
  const history = await db
    .selectFrom("database_backups")
    .select((eb) => [
      eb.fn.countAll<number>().as("attempts"),
      sql<string | null>`MAX(COALESCE(finished_at, started_at))`.as("last_activity_at"),
    ])
    .where("backup_date", "=", today)
    .executeTakeFirst();

  const attempts = Number(history?.attempts ?? 0);
  if (attempts >= config.maxAttemptsPerDay) {
    return {
      due: false,
      backupDate: today,
      reason: "attempts_exhausted",
      detail: `${attempts} attempts already made today (max ${config.maxAttemptsPerDay})`,
    };
  }

  if (attempts > 0 && config.retryBackoffMinutes > 0) {
    const withinBackoff = await db
      .selectFrom("database_backups")
      .select("id")
      .where("backup_date", "=", today)
      .where(
        sql<SqlBool>`COALESCE(finished_at, started_at) > datetime('now', ${`-${config.retryBackoffMinutes} minutes`})`,
      )
      .limit(1)
      .executeTakeFirst();
    if (withinBackoff) {
      return {
        due: false,
        backupDate: today,
        reason: "retry_backoff",
        detail: `waiting ${config.retryBackoffMinutes} minutes between attempts`,
      };
    }
  }

  const attempt = attempts + 1;

  if (hour >= config.hourUtc) {
    return { due: true, backupDate: today, attempt, reason: "scheduled" };
  }

  // Before the configured hour, but yesterday never succeeded — a server
  // that was down all night backs up as soon as it returns. The run files
  // under TODAY, not the missed day: the snapshot is of now, and claiming
  // today means the later scheduled tick sees `day_claimed` and skips.
  // Exactly one backup per calendar day either way.
  const yesterday = shiftDate(today, -1);
  const yesterdaySuccess = await db
    .selectFrom("database_backups")
    .select("id")
    .where("backup_date", "=", yesterday)
    .where("status", "=", "success")
    .limit(1)
    .executeTakeFirst();
  if (!yesterdaySuccess) {
    return { due: true, backupDate: today, attempt, reason: "catch_up" };
  }

  return {
    due: false,
    backupDate: today,
    reason: "before_hour",
    detail: `hour ${hour} is before BACKUP_HOUR_UTC=${config.hourUtc}`,
  };
}
