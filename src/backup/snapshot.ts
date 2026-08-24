/**
 * Taking a consistent on-disk snapshot of the live database with `VACUUM INTO`.
 *
 * The connection is a DEDICATED better-sqlite3 handle, never the app's
 * Kysely singleton: vacuuming through that connection would queue every
 * HTTP query behind it for the full duration — on top of the blocking
 * SQLite itself does. better-sqlite3 is synchronous, so the event loop
 * still pauses for the vacuum; a personal ledger is small enough that this
 * is a brief nightly blip rather than a reason to shell out to `sqlite3`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import SQLite from "better-sqlite3";

/** Orphans older than this are assumed dead. Must comfortably exceed a real run. */
const ORPHAN_AGE_MS = 6 * 60 * 60 * 1000;
const TEMP_PREFIX = ".backup-tmp-";
const TEMP_SUFFIX = ".sqlite";
const BUSY_TIMEOUT_MS = 30_000;
/** Only 1.2× because the gzip is streamed and never touches disk. */
const DISK_HEADROOM_FACTOR = 1.2;

/**
 * The `runId` is what stops a forced manual run from clobbering a concurrent
 * scheduled run's file.
 */
export function tempSnapshotPath(
  tmpDir: string,
  backupDate: string,
  runId: number,
): string {
  return path.join(tmpDir, `${TEMP_PREFIX}${backupDate}-${runId}${TEMP_SUFFIX}`);
}

function assertSafeSqlPath(label: string, value: string): void {
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path, got ${JSON.stringify(value)}`);
  }
  if (/['\n\r\0]/.test(value)) {
    throw new Error(`${label} must not contain quotes or newlines`);
  }
}

/**
 * Bytes that have to be captured: the main file plus anything still sitting
 * in the WAL. Used both for the reported `source_bytes` and for the disk
 * precheck, so a big WAL tail cannot make the estimate too optimistic.
 */
export async function statSourceBytes(dbPath: string): Promise<number> {
  const main = await fs.stat(dbPath);
  let total = main.size;
  try {
    const wal = await fs.stat(`${dbPath}-wal`);
    total += wal.size;
  } catch {
    // No WAL sidecar (or not readable) — the main file is the whole database.
  }
  return total;
}

/**
 * Check free space BEFORE vacuuming, so a full volume costs nothing rather
 * than a full-size write followed by ENOSPC.
 */
export async function assertDiskSpace(
  tmpDir: string,
  sourceBytes: number,
): Promise<void> {
  const required = Math.ceil(sourceBytes * DISK_HEADROOM_FACTOR);
  const stats = await fs.statfs(tmpDir);
  const available = Number(stats.bsize) * Number(stats.bavail);
  if (available < required) {
    throw new Error(
      `Not enough free space in ${tmpDir}: ${available} bytes available, ` +
        `${required} required (${sourceBytes} bytes of database plus 20% headroom)`,
    );
  }
}

/**
 * Delete leftover snapshots from runs that were killed.
 *
 * MANDATORY, not an optimisation: SIGKILL is the expected shutdown path in
 * production (PID 1 is the Dockerfile's shell, which does not forward
 * signals), and a killed run leaves a full-size orphan behind — enough of
 * those fill the volume.
 *
 * THE AGE CHECK IS NOT OPTIONAL. Deleting by name pattern alone would eat
 * a live run's snapshot out from under it.
 */
export async function sweepOrphanTempFiles(tmpDir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(tmpDir);
  } catch (error) {
    console.warn(`[backup] could not sweep ${tmpDir}`, error);
    return 0;
  }

  const cutoff = Date.now() - ORPHAN_AGE_MS;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(TEMP_PREFIX) || !entry.endsWith(TEMP_SUFFIX)) {
      continue;
    }
    const candidate = path.join(tmpDir, entry);
    try {
      const stats = await fs.stat(candidate);
      if (stats.mtimeMs >= cutoff) continue;
      await fs.rm(candidate, { force: true });
      removed += 1;
      console.warn(`[backup] swept orphan snapshot ${candidate}`);
    } catch (error) {
      console.warn(`[backup] could not sweep ${candidate}`, error);
    }
  }
  return removed;
}

/**
 * `VACUUM INTO` a fresh, fully checkpointed copy of the database.
 *
 * The destination path is interpolated into the statement because `VACUUM
 * INTO` CANNOT BE PARAMETERISED — the one place in this feature where
 * string-built SQL is unavoidable. Hence the validation above and the
 * quote doubling below; the value is not user input, but it does come
 * from an env var.
 *
 * `fileMustExist: true` so a wrong DATABASE_PATH errors rather than
 * silently creating an empty database and then dutifully backing it up.
 */
export async function vacuumInto(dbPath: string, destPath: string): Promise<void> {
  assertSafeSqlPath("Database path", dbPath);
  assertSafeSqlPath("Snapshot destination", destPath);

  await fs.rm(destPath, { force: true });

  const snap = new SQLite(dbPath, { fileMustExist: true });
  try {
    snap.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    snap.exec(`VACUUM INTO '${destPath.replace(/'/g, "''")}'`);
  } finally {
    snap.close();
  }
}
