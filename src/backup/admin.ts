/**
 * Admin GET payload. Always succeeds with a body once authorised — a
 * configuration problem is DATA here, not an error. The whole point of
 * the page is to show you what is wrong, and a 500 would show you nothing.
 */

import { db } from "../db/index.ts";
import type { DatabaseBackupsTable } from "../db/types.ts";
import type { Selectable } from "kysely";
import { getBackupConfig, redactBackupConfig, scrubSecrets } from "./config.ts";
import { summariseBucketStorage } from "./retention.ts";
import { createS3Client } from "./s3.ts";
import { getSchedulerState } from "./scheduler.ts";
import type {
  AdminBackupsResponse,
  BackupRunSummary,
  BackupStats,
} from "./types.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** How far back to look when counting the current failure streak. */
const STREAK_WINDOW = 200;

type BackupRow = Selectable<DatabaseBackupsTable>;

function sqliteUtcToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalised = value.includes("T") ? value : value.replace(" ", "T");
  const withZone = /Z$|[+-]\d{2}:\d{2}$/.test(normalised)
    ? normalised
    : `${normalised}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function summariseRun(row: BackupRow): BackupRunSummary {
  return {
    id: row.id,
    backupDate: row.backup_date,
    ownsDay: row.claim_key !== null,
    trigger: row.trigger,
    status: row.status,
    attempt: row.attempt,
    isWeekly: row.is_weekly === 1,
    dailyKey: row.daily_key,
    weeklyKey: row.weekly_key,
    sourceBytes: row.source_bytes,
    snapshotBytes: row.snapshot_bytes,
    compressedBytes: row.compressed_bytes,
    durationMs: row.duration_ms,
    prunedObjectCount: row.pruned_object_count,
    error: row.error_message ? scrubSecrets(row.error_message) : null,
    startedAt: sqliteUtcToIso(row.started_at),
    heartbeatAt: sqliteUtcToIso(row.heartbeat_at),
    finishedAt: sqliteUtcToIso(row.finished_at),
  };
}

export function parseLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

export async function getAdminBackupsPayload(
  limit: number,
): Promise<AdminBackupsResponse> {
  const config = redactBackupConfig();
  const scheduler = getSchedulerState();

  let runs: BackupRunSummary[] = [];
  let stats: BackupStats = {
    total: 0,
    lastSuccess: null,
    lastFailure: null,
    consecutiveFailures: 0,
  };
  let databaseError: string | null = null;
  let storage: AdminBackupsResponse["storage"] = null;
  let storageError: string | null = null;

  const configState = getBackupConfig();
  if (configState.status === "ready") {
    try {
      storage = await summariseBucketStorage(
        createS3Client(configState.settings),
        configState.settings,
      );
    } catch (error) {
      storageError = scrubSecrets(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
      console.error("[backup] admin GET could not list bucket objects", error);
    }
  }

  try {
    const [rows, countRow, lastSuccess] = await Promise.all([
      db
        .selectFrom("database_backups")
        .selectAll()
        .orderBy("id", "desc")
        .limit(limit)
        .execute(),
      db
        .selectFrom("database_backups")
        .select((eb) => eb.fn.countAll<number>().as("total"))
        .executeTakeFirst(),
      db
        .selectFrom("database_backups")
        .selectAll()
        .where("status", "=", "success")
        .orderBy("id", "desc")
        .limit(1)
        .executeTakeFirst(),
    ]);

    runs = rows.map(summariseRun);
    const recent = await db
      .selectFrom("database_backups")
      .selectAll()
      .orderBy("id", "desc")
      .limit(STREAK_WINDOW)
      .execute();
    const lastFailure = recent.find(
      (row) => row.status === "failed" || row.status === "abandoned",
    );

    let consecutiveFailures = 0;
    for (const row of recent) {
      if (row.status === "success") break;
      if (row.status === "failed" || row.status === "abandoned") {
        consecutiveFailures += 1;
      }
    }

    stats = {
      total: Number(countRow?.total ?? 0),
      lastSuccess: lastSuccess ? summariseRun(lastSuccess) : null,
      lastFailure: lastFailure ? summariseRun(lastFailure) : null,
      consecutiveFailures,
    };
  } catch (error) {
    databaseError = scrubSecrets(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    );
    console.error("[backup] admin GET could not read the runs table", error);
  }

  return {
    config,
    scheduler,
    stats,
    storage,
    storageError,
    runs,
    databaseError,
  };
}
