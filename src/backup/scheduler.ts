/**
 * The in-process scheduler: a ticker that asks the database whether
 * today's backup is due.
 *
 * There is no cron and no external trigger. Ticking every 15 minutes
 * against DB-recorded state means a server that was down at the appointed
 * hour simply catches up on its next tick, and it needs nothing on the
 * host.
 */

import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import { getBackupConfig, logBackupConfigOnce } from "./config.ts";
import {
  drainBackupRunner,
  getRunnerState,
  runScheduledBackupIfDue,
} from "./runner.ts";

/** Boot must never kick off a full-database vacuum, so the first tick waits. */
const FIRST_TICK_DELAY_MS = 60_000;

type SchedulerState = {
  armed: boolean;
  reason: string | null;
  tickMinutes: number | null;
  hourUtc: number | null;
  startedAt: string;
  lastTickAt: string | null;
  abort: AbortController;
};

export type SchedulerStateView = {
  /**
   * "unknown" means `startBackupScheduler()` never ran in this process —
   * typically because this module was imported from a test rather than
   * from the server entry point.
   */
  state: "running" | "not-started" | "unknown";
  reason: string | null;
  tickMinutes: number | null;
  startedAt: string | null;
  lastTickAt: string | null;
  nextTickAt: string | null;
  nextDueAt: string | null;
  inFlight: boolean;
  currentRunId: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
};

let scheduler: SchedulerState | null = null;

/** The next UTC instant at which the hour gate opens. */
function nextHourGate(now: Date, hourUtc: number): string {
  const candidate = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      hourUtc,
      0,
      0,
      0,
    ),
  );
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate.toISOString();
}

/**
 * A tick must NEVER reject: it runs from a timer, where an unhandled
 * rejection can take the process down.
 */
async function safeTick(current: SchedulerState): Promise<void> {
  current.lastTickAt = new Date().toISOString();
  try {
    await runScheduledBackupIfDue(current.abort.signal);
  } catch (error) {
    console.error("[backup] scheduler tick failed", error);
  }
}

/**
 * SYNCHRONOUS, NEVER THROWS, NEVER TOUCHES THE DATABASE.
 *
 * That is structural, not incidental: it is what guarantees a locked or
 * missing database can neither delay nor fail server boot.
 */
export function startBackupScheduler(): void {
  try {
    if (scheduler) return;

    const current: SchedulerState = {
      armed: false,
      reason: null,
      tickMinutes: null,
      hourUtc: null,
      startedAt: new Date().toISOString(),
      lastTickAt: null,
      abort: new AbortController(),
    };
    scheduler = current;

    logBackupConfigOnce();

    const config = getBackupConfig();
    if (config.status !== "ready") {
      current.reason =
        config.status === "disabled"
          ? "BACKUP_ENABLED is false"
          : `configuration problems: ${config.problems
              .map((problem) => `${problem.key} (${problem.reason})`)
              .join(", ")}`;
      console.log(`[backup] scheduler not armed — ${current.reason}`);
      return;
    }

    current.tickMinutes = config.settings.tickMinutes;
    current.hourUtc = config.settings.hourUtc;

    const tickMs = config.settings.tickMinutes * 60_000;
    let interval: ReturnType<typeof setInterval> | null = null;

    const first = setTimeout(() => {
      void safeTick(current);
      interval = setInterval(() => void safeTick(current), tickMs);
      interval.unref();
    }, FIRST_TICK_DELAY_MS);
    first.unref();

    const onShutdown = () => {
      current.abort.abort();
      clearTimeout(first);
      if (interval) clearInterval(interval);
      void drainBackupRunner().finally(() => process.exit(0));
    };
    process.once("SIGTERM", onShutdown);
    process.once("SIGINT", onShutdown);

    current.armed = true;
    console.log(
      `[backup] scheduler armed — tick every ${config.settings.tickMinutes} min, ` +
        `hour gate ${config.settings.hourUtc}:00 UTC, ` +
        `keeping ${config.settings.retentionDays} dailies plus one per ISO week`,
    );
  } catch (error) {
    console.error("[backup] scheduler failed to arm", error);
  }
}

/** Synchronous, initialises nothing — safe for the admin GET route. */
export function getSchedulerState(): SchedulerStateView {
  const runner = getRunnerState();

  if (!scheduler) {
    return {
      state: "unknown",
      reason:
        "startBackupScheduler() has not run in this process — it is started " +
        "from src/server.ts only when the process is the server, not a test",
      tickMinutes: null,
      startedAt: null,
      lastTickAt: null,
      nextTickAt: null,
      nextDueAt: null,
      inFlight: runner.inFlight,
      currentRunId: runner.currentRunId,
      lastError: runner.lastError,
      lastErrorAt: runner.lastErrorAt,
    };
  }

  let nextTickAt: string | null = null;
  if (scheduler.armed && scheduler.tickMinutes !== null) {
    const base = scheduler.lastTickAt
      ? new Date(scheduler.lastTickAt).getTime() + scheduler.tickMinutes * 60_000
      : new Date(scheduler.startedAt).getTime() + FIRST_TICK_DELAY_MS;
    nextTickAt = new Date(base).toISOString();
  }

  return {
    state: scheduler.armed ? "running" : "not-started",
    reason: scheduler.reason,
    tickMinutes: scheduler.tickMinutes,
    startedAt: scheduler.startedAt,
    lastTickAt: scheduler.lastTickAt,
    nextTickAt,
    nextDueAt:
      scheduler.hourUtc === null ? null : nextHourGate(new Date(), scheduler.hourUtc),
    inFlight: runner.inFlight,
    currentRunId: runner.currentRunId,
    lastError: runner.lastError,
    lastErrorAt: runner.lastErrorAt,
  };
}
