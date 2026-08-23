/**
 * Balance calculation.
 *
 * All balances are derived by summing `expense_repayments`, which is written at
 * expense-save time by src/domain/expenses.ts. That keeps these queries to a
 * plain SUM ... GROUP BY instead of re-deriving the creditor/debtor matching on
 * every page load.
 *
 * CURRENCIES ARE NEVER MIXED. Every function here returns per-currency figures,
 * because netting USD against EUR requires an exchange rate and an opinion about
 * when it was taken; neither of which belongs in a ledger.
 */
import { sql } from "kysely";
import type { DB } from "../db/index.ts";
import { pairwiseWithSimplify, type PairwiseEdge } from "./settle.ts";

// `simplifyDebts` lives in a pure module so the offline mirror can run the same
// implementation in the browser. Re-exported here so existing callers are
// unaffected by where it sits.
export { simplifyDebts, pairwiseWithSimplify } from "./settle.ts";

export interface CurrencyAmount {
  currencyCode: string;
  /** Positive = you are owed. Negative = you owe. */
  amountMinor: number;
}

export interface PairwiseBalance {
  otherUserId: string;
  balances: CurrencyAmount[];
}

export interface GroupMemberBalance {
  userId: string;
  balances: CurrencyAmount[];
}

/**
 * Net balance between one user and every other user they share history with,
 * across all groups and one-on-one expenses.
 *
 * This is what the friends list and the Splitwise-compatible `get_friends`
 * endpoint are built on. Groups with `simplify_by_default` contribute their
 * simplified edges, not the raw per-bill who-owes-whom. One-on-one expenses
 * stay pairwise: friends who are not in a group together are not asked to
 * settle with a third person. Summing a person's rows from
 * `getPairwiseBalancesByGroup` reproduces this exactly.
 */
export async function getPairwiseBalances(
  db: DB,
  userId: string,
): Promise<PairwiseBalance[]> {
  const byGroup = await getPairwiseBalancesByGroup(db, userId);
  const byUser = new Map<string, Map<string, number>>();

  for (const row of byGroup) {
    const totals = byUser.get(row.otherUserId) ?? new Map<string, number>();
    for (const b of row.balances) {
      totals.set(b.currencyCode, (totals.get(b.currencyCode) ?? 0) + b.amountMinor);
    }
    byUser.set(row.otherUserId, totals);
  }

  return [...byUser.entries()]
    .map(([otherUserId, totals]) => ({
      otherUserId,
      balances: [...totals.entries()]
        .filter(([, amount]) => amount !== 0)
        .map(([currencyCode, amountMinor]) => ({ currencyCode, amountMinor }))
        .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode)),
    }))
    .filter((row) => row.balances.length > 0)
    .sort((a, b) => (a.otherUserId < b.otherUserId ? -1 : 1));
}

export interface PairwiseGroupBalance {
  otherUserId: string;
  /** NULL for one-on-one expenses that belong to no group. */
  groupId: string | null;
  balances: CurrencyAmount[];
}

/**
 * The same pairwise figures as `getPairwiseBalances`, but split out by which
 * group each debt arose in.
 *
 * This is what lets the dashboard say "Grace owes you 74.02 USD for Non-group
 * expenses and 6198 JPY for 2025 Kyushu Autumn" rather than one opaque net
 * number. Summing a person's rows here reproduces `getPairwiseBalances`
 * exactly; same source table, one extra GROUP BY column, then the same
 * per-group simplify pass.
 */
export async function getPairwiseBalancesByGroup(
  db: DB,
  userId: string,
): Promise<PairwiseGroupBalance[]> {
  const [raw, nets, flags] = await Promise.all([
    rawPairwiseByGroup(db, userId),
    groupNets(db, userId),
    simplifyFlags(db),
  ]);

  const edges = pairwiseWithSimplify({
    viewerId: userId,
    raw,
    nets,
    simplifyByGroupId: flags,
  });

  return assemblePairwiseByGroup(edges);
}

async function rawPairwiseByGroup(db: DB, userId: string): Promise<PairwiseEdge[]> {
  // Repayments where the user is the debtor count negative; where they are the
  // creditor, positive. UNION ALL then aggregate, so each direction is a simple
  // indexed scan rather than an OR across two columns.
  const rows = await sql<{
    other_user_id: string;
    group_id: string | null;
    currency_code: string;
    amount_minor: number;
  }>`
    SELECT other_user_id, group_id, currency_code, SUM(amount_minor) AS amount_minor
    FROM (
      SELECT r.to_user_id   AS other_user_id,
             e.group_id,
             e.currency_code,
             -r.amount_minor AS amount_minor
      FROM expense_repayments r
      JOIN expenses e ON e.id = r.expense_id
      WHERE r.from_user_id = ${userId} AND e.deleted_at IS NULL

      UNION ALL

      SELECT r.from_user_id AS other_user_id,
             e.group_id,
             e.currency_code,
             r.amount_minor AS amount_minor
      FROM expense_repayments r
      JOIN expenses e ON e.id = r.expense_id
      WHERE r.to_user_id = ${userId} AND e.deleted_at IS NULL
    )
    GROUP BY other_user_id, group_id, currency_code
    HAVING SUM(amount_minor) <> 0
  `.execute(db);

  return rows.rows.map((row) => ({
    otherUserId: row.other_user_id,
    groupId: row.group_id,
    currencyCode: row.currency_code,
    amountMinor: row.amount_minor,
  }));
}

/**
 * Every participant's net in each group the viewer belongs to (including
 * groups they have left).
 *
 * Group nets include bills the viewer is not on: that is how simplify can
 * reroute a third party's debt onto them. Other people's groups are not
 * scanned. One-on-one expenses are never simplified, so they stay out.
 */
async function groupNets(db: DB, userId: string): Promise<Array<{
  groupId: string | null;
  userId: string;
  currencyCode: string;
  amountMinor: number;
}>> {
  const rows = await sql<{
    group_id: string | null;
    user_id: string;
    currency_code: string;
    amount_minor: number;
  }>`
    SELECT group_id, user_id, currency_code, SUM(amount_minor) AS amount_minor
    FROM (
      SELECT e.group_id,
             r.from_user_id AS user_id,
             e.currency_code,
             -r.amount_minor AS amount_minor
      FROM expense_repayments r
      JOIN expenses e ON e.id = r.expense_id
      WHERE e.deleted_at IS NULL
        AND e.group_id IN (SELECT group_id FROM group_members WHERE user_id = ${userId})

      UNION ALL

      SELECT e.group_id,
             r.to_user_id AS user_id,
             e.currency_code,
             r.amount_minor AS amount_minor
      FROM expense_repayments r
      JOIN expenses e ON e.id = r.expense_id
      WHERE e.deleted_at IS NULL
        AND e.group_id IN (SELECT group_id FROM group_members WHERE user_id = ${userId})
    )
    GROUP BY group_id, user_id, currency_code
    HAVING SUM(amount_minor) <> 0
  `.execute(db);

  return rows.rows.map((row) => ({
    groupId: row.group_id,
    userId: row.user_id,
    currencyCode: row.currency_code,
    amountMinor: row.amount_minor,
  }));
}

async function simplifyFlags(db: DB): Promise<Map<string, boolean>> {
  const rows = await db
    .selectFrom("groups")
    .select(["id", "simplify_by_default"])
    .where("deleted_at", "is", null)
    .execute();
  return new Map(rows.map((row) => [row.id, row.simplify_by_default === 1]));
}

function assemblePairwiseByGroup(edges: PairwiseEdge[]): PairwiseGroupBalance[] {
  const byPair = new Map<string, PairwiseGroupBalance>();

  for (const edge of edges) {
    const key = `${edge.otherUserId}:${edge.groupId ?? "none"}`;
    const entry = byPair.get(key) ?? {
      otherUserId: edge.otherUserId,
      groupId: edge.groupId,
      balances: [],
    };
    const existing = entry.balances.find((b) => b.currencyCode === edge.currencyCode);
    if (existing) existing.amountMinor += edge.amountMinor;
    else entry.balances.push({ currencyCode: edge.currencyCode, amountMinor: edge.amountMinor });
    byPair.set(key, entry);
  }

  const result: PairwiseGroupBalance[] = [];
  for (const entry of byPair.values()) {
    entry.balances = entry.balances
      .filter((b) => b.amountMinor !== 0)
      .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
    if (entry.balances.length > 0) result.push(entry);
  }

  result.sort((a, b) => {
    const user = a.otherUserId < b.otherUserId ? -1 : a.otherUserId > b.otherUserId ? 1 : 0;
    if (user !== 0) return user;
    if (a.groupId === b.groupId) return 0;
    if (a.groupId === null) return 1;
    if (b.groupId === null) return -1;
    return a.groupId < b.groupId ? -1 : 1;
  });
  return result;
}

/** Net balance between exactly two users, across all shared history. */
export async function getBalanceBetween(
  db: DB,
  userId: string,
  otherUserId: string,
): Promise<CurrencyAmount[]> {
  const all = await getPairwiseBalances(db, userId);
  return all.find((b) => b.otherUserId === otherUserId)?.balances ?? [];
}

/**
 * Each member's net position within a single group.
 *
 * Sums to zero per currency by construction. If it does not, something has
 * written expense_repayments directly; run `yarn db:check`.
 */
export async function getGroupBalances(
  db: DB,
  groupId: string,
): Promise<GroupMemberBalance[]> {
  const rows = await sql<{
    user_id: string;
    currency_code: string;
    amount_minor: number;
  }>`
    SELECT user_id, currency_code, SUM(amount_minor) AS amount_minor
    FROM (
      SELECT r.from_user_id AS user_id,
             e.currency_code,
             -r.amount_minor AS amount_minor
      FROM expense_repayments r
      JOIN expenses e ON e.id = r.expense_id
      WHERE e.group_id = ${groupId} AND e.deleted_at IS NULL

      UNION ALL

      SELECT r.to_user_id AS user_id,
             e.currency_code,
             r.amount_minor AS amount_minor
      FROM expense_repayments r
      JOIN expenses e ON e.id = r.expense_id
      WHERE e.group_id = ${groupId} AND e.deleted_at IS NULL
    )
    GROUP BY user_id, currency_code
    ORDER BY user_id, currency_code
  `.execute(db);

  const byUser = new Map<string, CurrencyAmount[]>();
  for (const row of rows.rows) {
    if (row.amount_minor === 0) continue;
    const list = byUser.get(row.user_id) ?? [];
    list.push({ currencyCode: row.currency_code, amountMinor: row.amount_minor });
    byUser.set(row.user_id, list);
  }

  return [...byUser.entries()].map(([userId, balances]) => ({ userId, balances }));
}

/**
 * A user's overall position: one signed total per currency.
 *
 * This is a SUM of pairwise balances. Simplify-debts redistributes who those
 * balances sit with, but not this total: a viewer's net in a group is invariant.
 */
export async function getTotalBalance(
  db: DB,
  userId: string,
): Promise<CurrencyAmount[]> {
  const pairwise = await getPairwiseBalances(db, userId);
  const totals = new Map<string, number>();

  for (const p of pairwise) {
    for (const b of p.balances) {
      totals.set(b.currencyCode, (totals.get(b.currencyCode) ?? 0) + b.amountMinor);
    }
  }

  return [...totals.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([currencyCode, amountMinor]) => ({ currencyCode, amountMinor }))
    .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}
