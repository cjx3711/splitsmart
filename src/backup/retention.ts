/**
 * Object naming and retention: all dailies for `retentionDays`, then one per
 * ISO week kept forever.
 */

import type { S3Client } from "@aws-sdk/client-s3";
import type { BackupSettings } from "./config.ts";
import { deleteObjects, listObjectKeys, listObjectSummaries } from "./s3.ts";
import { isoWeekBounds, shiftDate } from "./time.ts";

/**
 * EVERY S3 KEY IS A PURE FUNCTION OF `backup_date`.
 *
 * This is the invariant the whole failure model rests on: re-running a day
 * is an idempotent overwrite, never a duplicate, which is what makes
 * "upload succeeded but the database update failed" a recoverable state
 * rather than a mess. It breaks the moment anyone adds a timestamp, a run
 * id or a random suffix to these builders.
 */
export function dailyKey(prefix: string, date: string): string {
  return `${prefix}daily/${date}.sqlite.gz`;
}

export function weeklyKey(prefix: string, date: string): string {
  return `${prefix}weekly/${date}.sqlite.gz`;
}

/**
 * The leading `(?:^|\/)` is load-bearing. With an empty prefix the key is
 * `daily/<date>.sqlite.gz` with NO leading slash, so a `/\/daily\//`
 * pattern would match nothing and retention would silently no-op forever.
 * It fails safe (never deletes) but invisibly, which is precisely the
 * class of failure this feature exists to avoid.
 */
const DAILY_KEY_PATTERN = /(?:^|\/)daily\/(\d{4}-\d{2}-\d{2})\.sqlite\.gz$/;
const WEEKLY_KEY_PATTERN = /(?:^|\/)weekly\/(\d{4}-\d{2}-\d{2})\.sqlite\.gz$/;

/** Guard against a wildly wrong clock deleting the whole archive. */
const EARLIEST_PLAUSIBLE_DATE = "2026-01-01";
/** A prune bigger than this share of the bucket is treated as a bug, not a policy. */
const MAX_PRUNE_SHARE = 0.6;
const MAX_PRUNE_SHARE_EXEMPT_COUNT = 10;

export function parseDailyDate(key: string): string | null {
  return key.match(DAILY_KEY_PATTERN)?.[1] ?? null;
}

export function parseWeeklyDate(key: string): string | null {
  return key.match(WEEKLY_KEY_PATTERN)?.[1] ?? null;
}

export type PruneSelection = {
  toDelete: string[];
  /** Keys under `daily/` that could not be parsed, and so are never touched. */
  skipped: string[];
  /** Non-null means: delete nothing and log loudly. */
  refusal: string | null;
};

/**
 * Pure selection step, so the safety rails are testable without a bucket.
 *
 * "Keep 7 days" means today plus the 6 previous, so anything strictly older
 * than `today - (retentionDays - 1)` goes.
 */
export function selectDailyKeysToPrune(
  keys: string[],
  today: string,
  retentionDays: number,
): PruneSelection {
  if (today < EARLIEST_PLAUSIBLE_DATE) {
    return {
      toDelete: [],
      skipped: [],
      refusal: `refusing to prune: today is ${today}, before ${EARLIEST_PLAUSIBLE_DATE}, so the clock is wrong`,
    };
  }

  const cutoff = shiftDate(today, -(retentionDays - 1));
  const toDelete: string[] = [];
  const skipped: string[] = [];
  let matched = 0;

  for (const key of keys) {
    const date = parseDailyDate(key);
    if (!date) {
      skipped.push(key);
      continue;
    }
    matched += 1;
    if (date < cutoff) {
      toDelete.push(key);
    }
  }

  if (
    toDelete.length > MAX_PRUNE_SHARE_EXEMPT_COUNT &&
    matched > 0 &&
    toDelete.length > matched * MAX_PRUNE_SHARE
  ) {
    return {
      toDelete: [],
      skipped,
      refusal:
        `refusing to prune: ${toDelete.length} of ${matched} daily objects would be deleted ` +
        `(cutoff ${cutoff}), which looks like a clock jump rather than normal retention`,
    };
  }

  return { toDelete, skipped, refusal: null };
}

async function listDailyEntries(
  client: S3Client,
  settings: BackupSettings,
): Promise<string[]> {
  return listObjectKeys(client, settings, `${settings.keyPrefix}daily/`);
}

/** Dates of every existing weekly object, unsorted. Roughly 52 keys a year. */
export async function listWeeklyDates(
  client: S3Client,
  settings: BackupSettings,
): Promise<string[]> {
  const keys = await listObjectKeys(
    client,
    settings,
    `${settings.keyPrefix}weekly/`,
  );
  return keys
    .map(parseWeeklyDate)
    .filter((date): date is string => date !== null);
}

/**
 * Weekly selection is "FIRST SUCCESS OF THIS ISO WEEK", not a fixed anchor
 * weekday.
 *
 * With an anchor day, a failure that night — server down, credentials
 * rotated, disk briefly full — means the week gets no weekly object at all,
 * and its daily copy is deleted `retentionDays` later. Long-term retention
 * would be lost silently, and discovered months afterwards.
 *
 * The authoritative source is the BUCKET, not the database, so this
 * survives a database restore or a fresh database entirely.
 */
export async function shouldWriteWeekly(
  client: S3Client,
  settings: BackupSettings,
  today: string,
): Promise<boolean> {
  const { monday, sunday } = isoWeekBounds(today);
  const existing = await listWeeklyDates(client, settings);
  return !existing.some((date) => date >= monday && date <= sunday);
}

/**
 * Delete daily objects outside the retention window. Delete-only, and only
 * under `daily/` — `weekly/` is never pruned.
 *
 * The caller runs this AFTER success is recorded and inside its own
 * try/catch: a stored backup is worth more than a tidy bucket, so pruning
 * must never fail the backup.
 */
export async function pruneDailyObjects(
  client: S3Client,
  settings: BackupSettings,
  today: string,
): Promise<number> {
  const keys = await listDailyEntries(client, settings);
  const selection = selectDailyKeysToPrune(keys, today, settings.retentionDays);

  if (selection.skipped.length > 0) {
    console.warn(
      `[backup] prune skipped ${selection.skipped.length} unparseable key(s) under ` +
        `${settings.keyPrefix}daily/: ${selection.skipped.slice(0, 5).join(", ")}`,
    );
  }

  if (selection.refusal) {
    console.error(`[backup] ${selection.refusal}`);
    return 0;
  }

  if (selection.toDelete.length === 0) return 0;

  const deleted = await deleteObjects(client, settings, selection.toDelete);
  console.log(
    `[backup] pruned ${deleted} daily object(s) older than ` +
      `${shiftDate(today, -(settings.retentionDays - 1))}`,
  );
  return deleted;
}

export type BucketStorageSummary = {
  totalBytes: number;
  dailyBytes: number;
  weeklyBytes: number;
  dailyObjectCount: number;
  weeklyObjectCount: number;
};

type Sized = { size: number };

function sumSizes(objects: Sized[]): number {
  return objects.reduce((total, object) => total + object.size, 0);
}

/**
 * Pure summing step, so the admin total is testable without a bucket. Daily
 * and weekly prefixes are listed separately because those are the only two
 * trees this feature writes.
 */
export function summariseObjectSizes(
  dailies: Sized[],
  weeklies: Sized[],
): BucketStorageSummary {
  const dailyBytes = sumSizes(dailies);
  const weeklyBytes = sumSizes(weeklies);
  return {
    totalBytes: dailyBytes + weeklyBytes,
    dailyBytes,
    weeklyBytes,
    dailyObjectCount: dailies.length,
    weeklyObjectCount: weeklies.length,
  };
}

/** What is actually in the bucket right now — pruned dailies are already gone. */
export async function summariseBucketStorage(
  client: S3Client,
  settings: BackupSettings,
): Promise<BucketStorageSummary> {
  const [dailies, weeklies] = await Promise.all([
    listObjectSummaries(client, settings, `${settings.keyPrefix}daily/`),
    listObjectSummaries(client, settings, `${settings.keyPrefix}weekly/`),
  ]);
  return summariseObjectSizes(dailies, weeklies);
}
