/**
 * The shape of `GET /api/v1/admin/backups`, in its own module so the
 * client can import it with `import type` without reaching into a route
 * file. The frontend copies the types via InferResponseType from the
 * Hono client; this file is the server-side source of truth.
 */

import type { RedactedBackupConfig } from "./config.ts";
import type { SchedulerStateView } from "./scheduler.ts";

export type BackupRunSummary = {
  id: number;
  backupDate: string;
  /** Whether this row still holds the day's claim. Forced manual runs never do. */
  ownsDay: boolean;
  trigger: string;
  status: string;
  attempt: number;
  isWeekly: boolean;
  dailyKey: string | null;
  weeklyKey: string | null;
  sourceBytes: number | null;
  snapshotBytes: number | null;
  compressedBytes: number | null;
  durationMs: number | null;
  prunedObjectCount: number | null;
  error: string | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
};

export type BackupStats = {
  total: number;
  lastSuccess: BackupRunSummary | null;
  lastFailure: BackupRunSummary | null;
  consecutiveFailures: number;
};

/** What is actually sitting in the bucket right now, not the sum of historical runs. */
export type BackupStorageSummary = {
  totalBytes: number;
  dailyBytes: number;
  weeklyBytes: number;
  dailyObjectCount: number;
  weeklyObjectCount: number;
};

export type AdminBackupsResponse = {
  config: RedactedBackupConfig;
  scheduler: SchedulerStateView;
  stats: BackupStats;
  storage: BackupStorageSummary | null;
  /** Set when the bucket could not be listed; stats and runs are still returned. */
  storageError: string | null;
  runs: BackupRunSummary[];
  /** Set when the runs table could not be read; config and scheduler are still returned. */
  databaseError: string | null;
};
