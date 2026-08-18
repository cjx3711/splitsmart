/**
 * Recurrence arithmetic. PURE: no database, no Node built-ins.
 *
 * Kept free of I/O for the same reason as src/domain/split.ts: the add-expense
 * form has to tell the user when the next bill lands, and a second
 * implementation of "a month after 31 January" in the browser would drift from
 * the server's. The job that actually generates occurrences lives in
 * src/domain/scheduler.ts, which is where the database access is.
 *
 * A series is one TEMPLATE expense plus ordinary expenses generated from it,
 * each carrying `repeat_of`. There is no bundle id; see migrations/001.
 */

export const REPEAT_INTERVALS = ["weekly", "fortnightly", "monthly", "yearly"] as const;

export type RepeatInterval = (typeof REPEAT_INTERVALS)[number];

export function isRepeatInterval(value: unknown): value is RepeatInterval {
  return typeof value === "string" && (REPEAT_INTERVALS as readonly string[]).includes(value);
}

export class RecurrenceError extends Error {}

/** How the repeat control and the expense page say it out loud. */
export function repeatLabel(interval: RepeatInterval): string {
  switch (interval) {
    case "weekly":
      return "Weekly";
    case "fortnightly":
      return "Every 2 weeks";
    case "monthly":
      return "Monthly";
    case "yearly":
      return "Yearly";
  }
}

const MS_PER_DAY = 86_400_000;

/**
 * The instant one interval after `from`.
 *
 * Everything is done in UTC deliberately: expenses store an ISO-8601 UTC
 * timestamp, and letting the server's local timezone decide what "the same day
 * next month" means would make the answer depend on where the box is.
 *
 * Monthly and yearly CLAMP to the end of the target month, because the
 * alternative is silent drift: a bill on the 31st advanced naively by one month
 * becomes 3 March, then 3 April, and by the end of the year the rent is due on a
 * date nobody chose. Clamping keeps 31 January → 28 February → 31 March, so a
 * long series stays anchored to the day it was set up on.
 */
export function nextOccurrence(from: string, interval: RepeatInterval): string {
  const start = new Date(from);
  if (Number.isNaN(start.getTime())) {
    throw new RecurrenceError(`Invalid date: ${from}`);
  }

  if (interval === "weekly") return new Date(start.getTime() + 7 * MS_PER_DAY).toISOString();
  if (interval === "fortnightly") return new Date(start.getTime() + 14 * MS_PER_DAY).toISOString();

  const months = interval === "monthly" ? 1 : 12;
  const year = start.getUTCFullYear();
  const month = start.getUTCMonth() + months;
  const day = start.getUTCDate();

  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const lastDay = daysInMonth(targetYear, targetMonth);

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(day, lastDay),
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
      start.getUTCMilliseconds(),
    ),
  ).toISOString();
}

/** Day 0 of the next month is the last day of this one. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * When a brand-new template should first fire.
 *
 * One interval after the expense's own date, so entering "rent, monthly, 1st of
 * this month" does not immediately generate a second copy for the month you just
 * paid for. A date far in the past therefore leaves the series behind on
 * purpose; the scheduler catches up one bill per tick and the UI says so.
 */
export function firstScheduledRepeat(date: string, interval: RepeatInterval): string {
  return nextOccurrence(date, interval);
}

/** True when the series has a bill the scheduler owes you. Display only. */
export function isBehind(nextRepeat: string, now: Date = new Date()): boolean {
  const due = new Date(nextRepeat);
  return !Number.isNaN(due.getTime()) && due.getTime() <= now.getTime();
}

/**
 * The template this expense belongs to, or null if it is not in a series.
 *
 * The template's own id plus `repeat_of` IS the bundle: there is no series
 * table. An occurrence points at the template; the template points at nothing.
 */
export function seriesTemplateId(
  id: string,
  repeatOf: string | null | undefined,
  repeatInterval: string | null | undefined,
): string | null {
  if (repeatOf) return repeatOf;
  if (repeatInterval) return id;
  return null;
}
