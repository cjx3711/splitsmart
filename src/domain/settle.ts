/**
 * Settle-up suggestions.
 *
 * PURE, and its own module for exactly one reason: the browser imports it. The
 * offline mirror derives every balance locally (docs/OFFLINE.md, decision 3), and
 * src/domain/balances.ts cannot be imported into a bundle - it pulls in kysely.
 * Same arrangement as src/domain/split.ts, src/domain/ulid.ts and
 * src/domain/recurring.ts: keep it free of I/O and both sides can run the one
 * implementation instead of drifting apart by a cent.
 *
 * src/domain/balances.ts re-exports this, so server callers need not know it
 * moved.
 */
/**
 * Collapses a set of net positions into the fewest transfers that settle them
 * ("simplify debts").
 *
 * Greedy largest-creditor / largest-debtor matching. This is not guaranteed
 * minimal in the general case; that problem is NP-hard, but it produces at
 * most n-1 transfers and matches what people expect. Purely presentational:
 * nothing here is written to the database.
 */
export function simplifyDebts(
  balances: Array<{ userId: string; amountMinor: number }>,
): Array<{ fromUserId: string; toUserId: string; amountMinor: number }> {
  const total = balances.reduce((sum, b) => sum + b.amountMinor, 0);
  if (total !== 0) {
    throw new Error(
      `Cannot simplify: balances sum to ${total}, expected 0. The ledger is inconsistent.`,
    );
  }

  const creditors = balances
    .filter((b) => b.amountMinor > 0)
    .map((b) => ({ ...b }))
    .sort((a, b) => b.amountMinor - a.amountMinor || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

  const debtors = balances
    .filter((b) => b.amountMinor < 0)
    .map((b) => ({ userId: b.userId, amountMinor: -b.amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

  const transfers: Array<{ fromUserId: string; toUserId: string; amountMinor: number }> = [];
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
