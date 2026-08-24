/**
 * Date helpers for the database backup feature.
 *
 * EVERYTHING HERE IS UTC. There is no timezone handling anywhere in this
 * feature: `BACKUP_HOUR_UTC=0` means midnight UTC, not local midnight, and a
 * "backup day" is a UTC calendar day. That is a deliberate simplification —
 * the same date string is used as the day-claim key and as the S3 object
 * name, so it has to be unambiguous.
 *
 * Row timestamps (`started_at`, `heartbeat_at`, `finished_at`) are UTC too:
 * SQLite's `datetime('now')` is UTC, so comparing them lexically against
 * `datetime('now', …)` is valid.
 *
 * Pure functions only — no I/O, no `process.env`, no clock reads (callers
 * pass `now`).
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** "YYYY-MM-DD" for the UTC calendar day containing `now`. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** UTC hour, 0-23. */
export function utcHour(now: Date): number {
  return now.getUTCHours();
}

/**
 * True when `date` is a real "YYYY-MM-DD" UTC calendar date. Rejects both
 * malformed strings and impossible ones like "2026-02-31", which `Date.UTC`
 * would silently roll over into March.
 */
export function isValidUtcDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) {
    return false;
  }
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return utcDate(parsed) === date;
}

function parseUtcDate(date: string): Date {
  if (!isValidUtcDate(date)) {
    throw new Error(`Invalid UTC date string: ${JSON.stringify(date)}`);
  }
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error(`Invalid UTC date string: ${JSON.stringify(date)}`);
  }
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Calendar-string arithmetic: `shiftDate("2026-03-01", -1)` is `"2026-02-28"`.
 * Works across month, year and leap-year boundaries because it goes through
 * `Date.UTC`.
 */
export function shiftDate(date: string, days: number): string {
  const parsed = parseUtcDate(date);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return utcDate(parsed);
}

/**
 * The Monday and Sunday bounding the ISO week that contains `date`, inclusive.
 * ISO weeks start on Monday, so `isoWeekBounds("2026-08-14")` (a Friday)
 * returns `{ monday: "2026-08-10", sunday: "2026-08-16" }`.
 */
export function isoWeekBounds(date: string): { monday: string; sunday: string } {
  const parsed = parseUtcDate(date);
  const daysSinceMonday = (parsed.getUTCDay() + 6) % 7;
  const monday = shiftDate(date, -daysSinceMonday);
  return { monday, sunday: shiftDate(monday, 6) };
}
