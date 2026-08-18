/**
 * Usage counts for the operator admin panel.
 *
 * Counts only — no expense titles, amounts, friend names, or link secrets.
 * The 30-day series buckets live expenses by bill `date` (not `created_at`),
 * because seed data stamps stable dates while created_at is "now" at seed time.
 */
import { sql, type SqlBool } from "kysely";
import { db } from "../db/index.ts";
import { listRelatedUserIds } from "./friends.ts";

export const USAGE_WINDOW_DAYS = 30;

export interface UsageCounts {
  expensesCreated: number;
  expensesParticipated: number;
  groups: number;
  friends: number;
  recurring: number;
  guestLinks: number;
  ghosts: number;
}

export interface UsageDay {
  date: string;
  count: number;
}

export interface AdminUserUsage {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
  counts: UsageCounts;
  series: UsageDay[];
}

const AS_OF_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD in UTC. Malformed / missing → today UTC. */
export function parseAsOf(raw: string | undefined | null, now = new Date()): string {
  if (raw && AS_OF_RE.test(raw)) {
    const [y, m, d] = raw.split("-").map(Number);
    const check = new Date(Date.UTC(y!, m! - 1, d!));
    if (
      check.getUTCFullYear() === y &&
      check.getUTCMonth() === m! - 1 &&
      check.getUTCDate() === d
    ) {
      return raw;
    }
  }
  return utcDateString(now);
}

export function utcDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Inclusive window of `days` ending on `asOf` (YYYY-MM-DD), oldest first. */
export function daysEndingOn(asOf: string, days = USAGE_WINDOW_DAYS): string[] {
  const [y, m, d] = asOf.split("-").map(Number);
  const end = Date.UTC(y!, m! - 1, d!);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(utcDateString(new Date(end - i * 86_400_000)));
  }
  return out;
}

async function countForUser(userId: string): Promise<UsageCounts> {
  const [
    created,
    participated,
    groups,
    recurring,
    guestLinks,
    relatedIds,
  ] = await Promise.all([
    db
      .selectFrom("expenses")
      .select(db.fn.countAll<number>().as("n"))
      .where("created_by", "=", userId)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow(),
    sql<{ n: number }>`
      SELECT COUNT(DISTINCT eu.expense_id) AS n
      FROM expense_users eu
      JOIN expenses e ON e.id = eu.expense_id
      WHERE eu.user_id = ${userId} AND e.deleted_at IS NULL
    `.execute(db),
    sql<{ n: number }>`
      SELECT COUNT(*) AS n
      FROM group_members gm
      JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = ${userId}
        AND gm.left_at IS NULL
        AND g.deleted_at IS NULL
    `.execute(db),
    sql<{ n: number }>`
      SELECT COUNT(DISTINCT e.id) AS n
      FROM expenses e
      JOIN expense_users eu ON eu.expense_id = e.id
      WHERE eu.user_id = ${userId}
        AND e.deleted_at IS NULL
        AND e.repeat_interval IS NOT NULL
        AND e.repeat_of IS NULL
    `.execute(db),
    db
      .selectFrom("access_links")
      .select(db.fn.countAll<number>().as("n"))
      .where("created_by", "=", userId)
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow(),
    listRelatedUserIds(db, userId),
  ]);

  let ghosts = 0;
  if (relatedIds.length > 0) {
    const ghostRow = await db
      .selectFrom("users")
      .select(db.fn.countAll<number>().as("n"))
      .where("id", "in", relatedIds)
      .where("is_ghost", "=", 1)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow();
    ghosts = Number(ghostRow.n);
  }

  return {
    expensesCreated: Number(created.n),
    expensesParticipated: Number(participated.rows[0]?.n ?? 0),
    groups: Number(groups.rows[0]?.n ?? 0),
    friends: relatedIds.length,
    recurring: Number(recurring.rows[0]?.n ?? 0),
    guestLinks: Number(guestLinks.n),
    ghosts,
  };
}

async function seriesForUser(userId: string, asOf: string): Promise<UsageDay[]> {
  const days = daysEndingOn(asOf);
  const start = days[0]!;
  const end = days[days.length - 1]!;

  // expenses.date is ISO-8601; take the calendar day in UTC via substr.
  const rows = await sql<{ day: string; n: number }>`
    SELECT substr(e.date, 1, 10) AS day, COUNT(*) AS n
    FROM expenses e
    WHERE e.created_by = ${userId}
      AND e.deleted_at IS NULL
      AND substr(e.date, 1, 10) >= ${start}
      AND substr(e.date, 1, 10) <= ${end}
    GROUP BY day
  `.execute(db);

  const byDay = new Map(rows.rows.map((r) => [r.day, Number(r.n)]));
  return days.map((date) => ({ date, count: byDay.get(date) ?? 0 }));
}

async function buildUsage(
  user: { id: string; name: string; email: string | null; created_at: string },
  asOf: string,
): Promise<AdminUserUsage> {
  const [counts, series] = await Promise.all([
    countForUser(user.id),
    seriesForUser(user.id, asOf),
  ]);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.created_at,
    counts,
    series,
  };
}

const LIST_CAP = 50;

/**
 * Real, live accounts. Empty q → most recently created, capped.
 * q matches name or email via instr(lower(...)).
 */
export async function listAdminUsers(
  q: string | undefined,
  asOf: string,
): Promise<AdminUserUsage[]> {
  const needle = q?.trim() ?? "";
  let query = db
    .selectFrom("users")
    .select(["id", "name", "email", "created_at"])
    .where("is_ghost", "=", 0)
    .where("deleted_at", "is", null);

  if (needle) {
    query = query.where((eb) =>
      eb.or([
        sql<SqlBool>`instr(lower(users.name), lower(${needle})) > 0`,
        sql<SqlBool>`users.email IS NOT NULL AND instr(lower(users.email), lower(${needle})) > 0`,
      ]),
    );
  }

  const rows = await query
    .orderBy("created_at", "desc")
    .limit(LIST_CAP)
    .execute();

  return Promise.all(rows.map((r) => buildUsage(r, asOf)));
}

/** One real account, or null if missing / ghost / deleted. */
export async function getAdminUser(
  userId: string,
  asOf: string,
): Promise<AdminUserUsage | null> {
  const row = await db
    .selectFrom("users")
    .select(["id", "name", "email", "created_at"])
    .where("id", "=", userId)
    .where("is_ghost", "=", 0)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  return buildUsage(row, asOf);
}
