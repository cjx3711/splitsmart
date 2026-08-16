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
 * when it was taken — neither of which belongs in a ledger.
 */
import { sql } from "kysely";
import type { DB } from "../db/index.ts";

export interface CurrencyAmount {
  currencyCode: string;
  /** Positive = you are owed. Negative = you owe. */
  amountMinor: number;
}

export interface PairwiseBalance {
  otherUserId: number;
  balances: CurrencyAmount[];
}

export interface GroupMemberBalance {
  userId: number;
  balances: CurrencyAmount[];
}

/**
 * Net balance between one user and every other user they share history with,
 * across all groups and one-on-one expenses.
 *
 * This is what the friends list and the Splitwise-compatible `get_friends`
 * endpoint are built on.
 */
export async function getPairwiseBalances(
  db: DB,
  userId: number,
): Promise<PairwiseBalance[]> {
  // Repayments where the user is the debtor count negative; where they are the
  // creditor, positive. UNION ALL then aggregate, so each direction is a simple
  // indexed scan rather than an OR across two columns.
  const rows = await sql<{
    other_user_id: number;
    currency_code: string;
    amount_minor: number;
  }>`
    SELECT other_user_id, currency_code, SUM(amount_minor) AS amount_minor
    FROM (
      SELECT r.to_user_id   AS other_user_id,
             e.currency_code,
             -r.amount_minor AS amount_minor
      FROM expense_repayments r
      JOIN expenses e ON e.id = r.expense_id
      WHERE r.from_user_id = ${userId} AND e.deleted_at IS NULL

      UNION ALL

      SELECT r.from_user_id AS other_user_id,
             e.currency_code,
             r.amount_minor AS amount_minor
      FROM expense_repayments r
      JOIN expenses e ON e.id = r.expense_id
      WHERE r.to_user_id = ${userId} AND e.deleted_at IS NULL
    )
    GROUP BY other_user_id, currency_code
    HAVING SUM(amount_minor) <> 0
    ORDER BY other_user_id, currency_code
  `.execute(db);

  const byUser = new Map<number, CurrencyAmount[]>();
  for (const row of rows.rows) {
    const list = byUser.get(row.other_user_id) ?? [];
    list.push({ currencyCode: row.currency_code, amountMinor: row.amount_minor });
    byUser.set(row.other_user_id, list);
  }

  return [...byUser.entries()].map(([otherUserId, balances]) => ({
    otherUserId,
    balances,
  }));
}

/** Net balance between exactly two users, across all shared history. */
export async function getBalanceBetween(
  db: DB,
  userId: number,
  otherUserId: number,
): Promise<CurrencyAmount[]> {
  const all = await getPairwiseBalances(db, userId);
  return all.find((b) => b.otherUserId === otherUserId)?.balances ?? [];
}

/**
 * Each member's net position within a single group.
 *
 * Sums to zero per currency by construction. If it does not, something has
 * written expense_repayments directly — run `yarn db:check`.
 */
export async function getGroupBalances(
  db: DB,
  groupId: number,
): Promise<GroupMemberBalance[]> {
  const rows = await sql<{
    user_id: number;
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

  const byUser = new Map<number, CurrencyAmount[]>();
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
 * Note this is a SUM of pairwise balances, which is not the same as "how much
 * cash would settle everything" when debts can be routed through third parties.
 * For that, use simplifyDebts.
 */
export async function getTotalBalance(
  db: DB,
  userId: number,
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

/**
 * Collapses a set of net positions into the fewest transfers that settle them
 * ("simplify debts").
 *
 * Greedy largest-creditor / largest-debtor matching. This is not guaranteed
 * minimal in the general case — that problem is NP-hard — but it produces at
 * most n-1 transfers and matches what people expect. Purely presentational:
 * nothing here is written to the database.
 */
export function simplifyDebts(
  balances: Array<{ userId: number; amountMinor: number }>,
): Array<{ fromUserId: number; toUserId: number; amountMinor: number }> {
  const total = balances.reduce((sum, b) => sum + b.amountMinor, 0);
  if (total !== 0) {
    throw new Error(
      `Cannot simplify: balances sum to ${total}, expected 0. The ledger is inconsistent.`,
    );
  }

  const creditors = balances
    .filter((b) => b.amountMinor > 0)
    .map((b) => ({ ...b }))
    .sort((a, b) => b.amountMinor - a.amountMinor || a.userId - b.userId);

  const debtors = balances
    .filter((b) => b.amountMinor < 0)
    .map((b) => ({ userId: b.userId, amountMinor: -b.amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor || a.userId - b.userId);

  const transfers: Array<{ fromUserId: number; toUserId: number; amountMinor: number }> = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci]!;
    const debtor = debtors[di]!;
    const amount = Math.min(creditor.amountMinor, debtor.amountMinor);

    if (amount > 0) {
      transfers.push({
        fromUserId: debtor.userId,
        toUserId: creditor.userId,
        amountMinor: amount,
      });
    }

    creditor.amountMinor -= amount;
    debtor.amountMinor -= amount;
    if (creditor.amountMinor === 0) ci++;
    if (debtor.amountMinor === 0) di++;
  }

  return transfers;
}
