/**
 * Orchestration. Owns the single try/catch/finally around a run, and the
 * in-flight guard.
 *
 * Sequence: mkdir + sweep orphans → stat source → assert disk space →
 * claim the day → start the heartbeat → VACUUM INTO → decide weekly →
 * upload the daily object → server-side copy to weekly → record success
 * → prune → record the pruned count.
 *
 * The three steps before the claim are deliberately cheap, and
 * deliberately do not consume one of the day's attempts: a full volume
 * should cost nothing and stay retryable. They are surfaced through
 * `getRunnerState().lastError` instead of a row, because there is no row
 * to write them to yet.
 */

import fs from "node:fs/promises";
import { clearInterval, setInterval } from "node:timers";
import type { S3Client } from "@aws-sdk/client-s3";
import { db } from "../db/index.ts";
import {
  type BackupSuccess,
  type BackupTrigger,
  claimDay,
  recordPrunedCount,
  recordSuccess,
  releaseOnFailure,
  releaseStaleClaim,
  touchHeartbeat,
} from "./claim.ts";
import {
  type BackupSettings,
  getBackupConfig,
  scrubSecrets,
} from "./config.ts";
import { evaluateDue } from "./due.ts";
import { dailyKey, pruneDailyObjects, shouldWriteWeekly, weeklyKey } from "./retention.ts";
import { copyObject, createS3Client, uploadGzipStream } from "./s3.ts";
import {
  assertDiskSpace,
  statSourceBytes,
  sweepOrphanTempFiles,
  tempSnapshotPath,
  vacuumInto,
} from "./snapshot.ts";
import { utcDate } from "./time.ts";

const HEARTBEAT_INTERVAL_MS = 60_000;

export type RunnerState = {
  inFlight: boolean;
  currentRunId: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

type MutableRunnerState = RunnerState & {
  abort: AbortController | null;
  startedAtMs: number | null;
};

export type TriggerBackupResult =
  | {
      kind: "started";
      id: number;
      backupDate: string;
      attempt: number;
      trigger: BackupTrigger;
    }
  | { kind: "already_running" }
  | { kind: "day_claimed" }
  | { kind: "not_configured" }
  | { kind: "error"; message: string };

const state: MutableRunnerState = {
  inFlight: false,
  currentRunId: null,
  lastError: null,
  lastErrorAt: null,
  abort: null,
  startedAtMs: null,
};

export function getRunnerState(): RunnerState {
  return {
    inFlight: state.inFlight,
    currentRunId: state.currentRunId,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
  };
}

function recordRunnerError(error: unknown): string {
  const message = scrubSecrets(
    error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  );
  state.lastError = message;
  state.lastErrorAt = new Date().toISOString();
  return message;
}

type PerformParams = {
  settings: BackupSettings;
  client: S3Client;
  runId: number;
  backupDate: string;
  sourceBytes: number;
  startedAtMs: number;
  signal: AbortSignal;
};

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Backup aborted (server shutting down)");
  }
}

async function performBackup(params: PerformParams): Promise<void> {
  const { settings, client, runId, backupDate, sourceBytes, startedAtMs, signal } =
    params;

  const tmpPath = tempSnapshotPath(settings.tmpDir, backupDate, runId);
  const heartbeat = setInterval(() => {
    void touchHeartbeat(runId).catch((error) => {
      console.warn(`[backup] heartbeat failed for run ${runId}`, error);
    });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  try {
    throwIfAborted(signal);
    await vacuumInto(settings.dbPath, tmpPath);
    const snapshotBytes = (await fs.stat(tmpPath)).size;

    throwIfAborted(signal);
    const wantsWeekly = await shouldWriteWeekly(client, settings, backupDate);

    const daily = dailyKey(settings.keyPrefix, backupDate);
    const { compressedBytes } = await uploadGzipStream({
      client,
      settings,
      key: daily,
      filePath: tmpPath,
      abortSignal: signal,
    });

    let weekly: string | null = null;
    if (wantsWeekly) {
      weekly = weeklyKey(settings.keyPrefix, backupDate);
      await copyObject(client, settings, daily, weekly);
    }

    const success: BackupSuccess = {
      isWeekly: weekly !== null,
      dailyKey: daily,
      weeklyKey: weekly,
      sourceBytes,
      snapshotBytes,
      compressedBytes,
      startedAtMs,
    };
    const recorded = await recordSuccess(runId, success);
    console.log(
      `[backup] run ${runId} uploaded ${daily}` +
        (weekly ? ` and copied to ${weekly}` : "") +
        ` (${compressedBytes} bytes compressed from ${snapshotBytes})` +
        (recorded ? "" : " — WARNING: success could not be recorded in the database"),
    );

    try {
      const pruned = await pruneDailyObjects(client, settings, backupDate);
      await recordPrunedCount(runId, pruned);
    } catch (error) {
      console.error(`[backup] prune failed after run ${runId} succeeded`, error);
    }
  } finally {
    clearInterval(heartbeat);
    try {
      await fs.rm(tmpPath, { force: true });
    } catch (error) {
      console.warn(`[backup] could not remove ${tmpPath}`, error);
    }
  }
}

type StartParams = {
  backupDate: string;
  attempt: number;
  trigger: BackupTrigger;
  force: boolean;
  /** When false, the caller returns immediately and the run continues in the background. */
  await: boolean;
};

async function startRun(
  settings: BackupSettings,
  params: StartParams,
): Promise<TriggerBackupResult> {
  if (state.inFlight) {
    return { kind: "already_running" };
  }
  state.inFlight = true;

  const abandonBeforeStart = (result: TriggerBackupResult): TriggerBackupResult => {
    state.inFlight = false;
    return result;
  };

  let sourceBytes: number;
  try {
    await fs.mkdir(settings.tmpDir, { recursive: true });
    await sweepOrphanTempFiles(settings.tmpDir);
    sourceBytes = await statSourceBytes(settings.dbPath);
    await assertDiskSpace(settings.tmpDir, sourceBytes);
  } catch (error) {
    return abandonBeforeStart({
      kind: "error",
      message: recordRunnerError(error),
    });
  }

  const claim = await claimDay(params.backupDate, {
    attempt: params.attempt,
    trigger: params.trigger,
    force: params.force,
  });
  if (claim.kind === "already_claimed") {
    return abandonBeforeStart({ kind: "day_claimed" });
  }
  if (claim.kind === "transient") {
    return abandonBeforeStart({
      kind: "error",
      message: recordRunnerError(claim.error),
    });
  }

  const abort = new AbortController();
  state.currentRunId = claim.id;
  state.abort = abort;
  const startedAtMs = Date.now();
  state.startedAtMs = startedAtMs;

  const client = createS3Client(settings);

  const work = (async () => {
    try {
      await performBackup({
        settings,
        client,
        runId: claim.id,
        backupDate: params.backupDate,
        sourceBytes,
        startedAtMs,
        signal: abort.signal,
      });
      state.lastError = null;
      state.lastErrorAt = null;
    } catch (error) {
      recordRunnerError(error);
      console.error(`[backup] run ${claim.id} failed`, error);
      try {
        await releaseOnFailure(claim.id, error, startedAtMs);
      } catch (updateError) {
        console.error(
          `[backup] run ${claim.id} failed AND could not be marked failed`,
          updateError,
        );
      }
    } finally {
      client.destroy();
      state.inFlight = false;
      state.currentRunId = null;
      state.abort = null;
      state.startedAtMs = null;
    }
  })();

  if (params.await) {
    await work;
  } else {
    void work;
  }

  return {
    kind: "started",
    id: claim.id,
    backupDate: params.backupDate,
    attempt: claim.attempt,
    trigger: params.trigger,
  };
}

/**
 * One scheduler tick. Awaits the run, so a tick never overlaps its own
 * successor beyond the in-flight guard.
 */
export async function runScheduledBackupIfDue(signal: AbortSignal): Promise<void> {
  const config = getBackupConfig();
  if (config.status !== "ready") return;
  if (signal.aborted) return;
  if (state.inFlight) return;

  const decision = await evaluateDue(config.settings, new Date());
  if (!decision.due) return;

  console.log(
    `[backup] ${decision.reason} run due for ${decision.backupDate} (attempt ${decision.attempt})`,
  );

  const result = await startRun(config.settings, {
    backupDate: decision.backupDate,
    attempt: decision.attempt,
    trigger: "scheduled",
    force: false,
    await: true,
  });

  if (result.kind === "error") {
    console.error(`[backup] scheduled run could not start: ${result.message}`);
  } else if (result.kind === "day_claimed") {
    console.log(
      `[backup] ${decision.backupDate} was claimed by another run; standing down`,
    );
  }
}

/**
 * Manual trigger. OWNS the in-flight guard — the route must not implement
 * its own.
 *
 * Not gated by the hour or the retry backoff: an operator asking for a
 * backup gets one. A stale claim is released first so a dead run cannot
 * block a manual retry.
 */
export async function triggerBackupNow(force: boolean): Promise<TriggerBackupResult> {
  const config = getBackupConfig();
  if (config.status !== "ready") {
    return { kind: "not_configured" };
  }

  const backupDate = utcDate(new Date());

  try {
    await releaseStaleClaim(backupDate, config.settings.staleAfterMinutes);
  } catch (error) {
    return { kind: "error", message: recordRunnerError(error) };
  }

  const attempts = await db
    .selectFrom("database_backups")
    .select((eb) => eb.fn.countAll<number>().as("attempts"))
    .where("backup_date", "=", backupDate)
    .executeTakeFirst();

  return startRun(config.settings, {
    backupDate,
    attempt: Number(attempts?.attempts ?? 0) + 1,
    trigger: "manual",
    force,
    await: false,
  });
}

/**
 * Shutdown drain. ABORTS, it does not finish: a multipart upload of a
 * whole database will not complete inside a shutdown window, and trying
 * is how you end up killed mid-write with the row still saying `running`.
 *
 * Purely an optimisation. In production PID 1 is the Dockerfile's `sh
 * -c`, which does not forward SIGTERM, so SIGKILL is the expected
 * shutdown path and the heartbeat/stale-reclaim path is the real
 * recovery mechanism. This just turns a 15-minute wait into an immediate
 * retry when node *is* PID 1.
 */
export async function drainBackupRunner(): Promise<void> {
  if (!state.inFlight || !state.abort || state.currentRunId === null) {
    return;
  }

  const runId = state.currentRunId;
  const startedAtMs = state.startedAtMs ?? Date.now();
  console.log(`[backup] aborting in-flight run ${runId} for shutdown`);
  state.abort.abort();

  try {
    await releaseOnFailure(
      runId,
      new Error("Aborted: server shutting down"),
      startedAtMs,
    );
  } catch (error) {
    console.warn(`[backup] could not mark run ${runId} failed during shutdown`, error);
  }
}
