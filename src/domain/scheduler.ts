/**
 * The recurring-expense job.
 *
 * One template plus the bills it has generated is a series (migrations/001).
 * This is the thing that generates them: it runs in the same Node process as
 * everything else, on boot and then on an interval, and it works off the SERVER
 * clock only. A client cannot ask for an occurrence, and a guest link cannot
 * create a template, because a series the owner did not start and cannot stop is
 * a bad surprise (docs/PARITY.md slice 2).
 *
 * Three rules that keep this from being a foot-gun:
 *
 * 1. **One occurrence per template per tick.** After downtime a series is
 *    behind; it catches up one bill at a time, each dated the day it was due.
 *    Inserting three months of rent in one pass, all dated today, is the failure
 *    mode this exists to avoid.
 * 2. **Generation goes through `createExpense`.** Rule 3. An occurrence is an
 *    ordinary expense: same participants, same split type, same split inputs,
 *    with `repeat_of` set and no schedule of its own.
 * 3. **It is idempotent per (template, due date).** The occurrence and the
 *    schedule advance cannot share a transaction - `createExpense` opens its own
 *    and SQLite has no nested BEGIN - so a crash between the two would otherwise
 *    duplicate a bill. Instead the generator checks for an occurrence already
 *    dated that day and skips it, which also makes a re-run free.
 *
 * Failures log and are retried on the next tick. One broken template must not
 * stop the others.
 */
import { db } from "../db/index.ts";
import { advanceRepeatSchedule, createExpense } from "./expenses.ts";
import { isRepeatInterval, type RepeatInterval } from "./recurring.ts";
import type { SplitItem, SplitType } from "./split.ts";
import { ulid } from "./ulid.ts";

/** How often the interval below fires. Hourly: a bill is never urgent to the minute. */
export const SCHEDULER_INTERVAL_MS = 3_600_000;

export interface GeneratedOccurrence {
  templateId: string;
  expenseId: string;
  /** The date the bill was due, not the date it was generated. */
  date: string;
}

export interface SchedulerRun {
  generated: GeneratedOccurrence[];
  /** Templates that were already caught up for their due date. */
  skipped: number;
  failures: Array<{ templateId: string; reason: string }>;
}

/**
 * Generates at most one occurrence for every template that is due.
 *
 * `now` is injectable so a test can drive a clock jump without waiting a month.
 */
export async function runDueRecurrences(
  now: Date = new Date(),
  mintId: () => string = ulid,
): Promise<SchedulerRun> {
  const result: SchedulerRun = { generated: [], skipped: 0, failures: [] };

  const due = await db
    .selectFrom("expenses")
    .select([
      "id",
      "group_id",
      "description",
      "details",
      "cost_minor",
      "currency_code",
      "category_id",
      "split_type",
      "split_meta",
      "is_payment",
      "payment_method",
      "repeat_interval",
      "next_repeat",
      "created_by",
    ])
    .where("repeat_interval", "is not", null)
    .where("deleted_at", "is", null)
    .where("next_repeat", "<=", now.toISOString())
    .orderBy("next_repeat")
    .execute();

  for (const template of due) {
    const interval = template.repeat_interval;
    const dueAt = template.next_repeat;

    if (!isRepeatInterval(interval) || dueAt === null) {
      // The schema CHECKs make this unreachable; treat it as a broken row rather
      // than crashing the tick.
      result.failures.push({ templateId: template.id, reason: "template has no usable schedule" });
      continue;
    }

    try {
      const outcome = await generateOccurrence(template, interval, dueAt, mintId);
      if (outcome === null) result.skipped++;
      else result.generated.push({ templateId: template.id, expenseId: outcome, date: dueAt });
    } catch (err) {
      // Logged rather than thrown: the next tick tries again, and one template
      // whose group lost a member must not stop everybody else's rent.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`Recurring expense ${template.id} could not be generated: ${reason}`);
      result.failures.push({ templateId: template.id, reason });
      continue;
    }

    // Advanced even when the occurrence already existed, or the series would
    // stick on the same due date forever.
    await advanceRepeatSchedule(template.id, dueAt, interval);
  }

  return result;
}

type TemplateRow = {
  id: string;
  group_id: string | null;
  description: string;
  details: string | null;
  cost_minor: number;
  currency_code: string;
  category_id: number | null;
  split_type: string;
  split_meta: string | null;
  is_payment: number;
  payment_method: string | null;
  created_by: string | null;
};

/** Returns the new expense id, or null when this due date is already covered. */
async function generateOccurrence(
  template: TemplateRow,
  interval: RepeatInterval,
  dueAt: string,
  mintId: () => string,
): Promise<string | null> {
  // Normalised the same way createExpense will normalise it, so the
  // already-generated lookup below compares like with like.
  const date = new Date(dueAt).toISOString();

  const already = await db
    .selectFrom("expenses")
    .select("id")
    .where("repeat_of", "=", template.id)
    .where("date", "=", date)
    .executeTakeFirst();

  if (already) return null;

  const shares = await db
    .selectFrom("expense_users")
    .select(["user_id", "paid_share_minor", "owed_share_minor", "split_input"])
    .where("expense_id", "=", template.id)
    .orderBy("user_id")
    .execute();

  if (shares.length === 0) {
    throw new Error("the template has no participants");
  }

  // The template's own split is replayed rather than re-derived: computeSplit is
  // deterministic, so the same type and the same per-person inputs give the same
  // cents, and the occurrence reopens in the editor as the same kind of split
  // the user set up instead of a wall of exact amounts.
  const meta = parseSplitMeta(template.split_meta);

  return createExpense({
    id: mintId(),
    groupId: template.group_id,
    description: template.description,
    details: template.details,
    costMinor: template.cost_minor,
    currencyCode: template.currency_code,
    date,
    categoryId: template.category_id,
    splitType: template.split_type as SplitType,
    participants: shares.map((s) => ({
      userId: s.user_id,
      paidMinor: s.paid_share_minor,
      input: s.split_input ?? undefined,
    })),
    ...(meta.items ? { items: meta.items } : {}),
    ...(meta.taxMinor !== undefined ? { taxMinor: meta.taxMinor } : {}),
    ...(meta.tipMinor !== undefined ? { tipMinor: meta.tipMinor } : {}),
    isPayment: template.is_payment === 1,
    paymentMethod: template.payment_method,
    // The occurrence is not itself a template. `repeat_of` is the only thing
    // that says where it came from.
    repeatOf: template.id,
    // Whoever set up the series owns the bills it produces. A template always
    // has a creator; the fallback keeps a hand-inserted row from crashing.
    createdBy: template.created_by ?? shares[0]!.user_id,
  });
}

function parseSplitMeta(raw: string | null): {
  items?: SplitItem[];
  taxMinor?: number;
  tipMinor?: number;
} {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as {
      items?: SplitItem[];
      taxMinor?: number;
      tipMinor?: number;
    };
    return {
      ...(Array.isArray(parsed.items) && parsed.items.length > 0 ? { items: parsed.items } : {}),
      ...(typeof parsed.taxMinor === "number" ? { taxMinor: parsed.taxMinor } : {}),
      ...(typeof parsed.tipMinor === "number" ? { tipMinor: parsed.tipMinor } : {}),
    };
  } catch {
    // split_meta is presentation detail, never ledger data. A blob we cannot
    // read costs the occurrence its line items, not its money.
    return {};
  }
}

/**
 * Boot + interval, called once from src/server.ts.
 *
 * Returns the timer so a caller can unref it; the process must not be held open
 * by a job whose whole purpose is to run again later.
 */
export function startRecurringScheduler(): NodeJS.Timeout {
  const tick = () => {
    void runDueRecurrences().catch((err) => {
      console.error("Recurring scheduler tick failed:", err instanceof Error ? err.message : err);
    });
  };

  tick();
  return setInterval(tick, SCHEDULER_INTERVAL_MS);
}
