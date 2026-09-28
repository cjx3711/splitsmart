/**
 * Groups the owner keeps out of their headline totals.
 *
 * A group can be marked "doesn't count towards totals" (`excluded_from_totals`
 * on the group; Group options writes it through web/src/groupSettings.ts). It
 * is for a group kept as a running ledger - an account, a float, a tab - where
 * the balance is real but is not a debt to a friend that belongs in "You owe".
 *
 * NOTHING HERE SUBTRACTS FROM THE LEDGER. The server keeps returning the full
 * pairwise total (`friend.balances`) and the full per-group breakdown that adds
 * up to it exactly; this module re-adds the buckets that count, in the browser,
 * for display. That is the whole reason the flag never reaches
 * src/domain/balances.ts: with both numbers in hand, "Include them" is a
 * re-render rather than a second query that could disagree with the first.
 *
 * Amounts are integer minor units per currency (CLAUDE.md, rule 1), so the sum
 * is exact and no rounding can creep in between the two views.
 */
import type { CurrencyAmount } from "./api.ts";

/** The shape both the server's and the mirror's breakdown entries satisfy. */
export interface CountableBucket {
  groupId: string | null;
  groupName?: string | null;
  excluded: boolean;
  balances: CurrencyAmount[];
}

/**
 * Per-currency totals from the buckets that count.
 *
 * Same output shape as a `balances` array off the wire: zero rows dropped,
 * sorted by currency code, so it drops straight into the components that
 * render one.
 */
export function countedBalances(breakdown: readonly CountableBucket[]): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const bucket of breakdown) {
    if (bucket.excluded) continue;
    for (const b of bucket.balances) {
      totals.set(b.currencyCode, (totals.get(b.currencyCode) ?? 0) + b.amountMinor);
    }
  }
  return [...totals.entries()]
    .filter(([, amountMinor]) => amountMinor !== 0)
    .map(([currencyCode, amountMinor]) => ({ currencyCode, amountMinor }))
    .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}

/** The buckets left out, and still holding something. */
export function excludedBuckets(
  breakdown: readonly CountableBucket[],
): CountableBucket[] {
  return breakdown.filter((bucket) => bucket.excluded && bucket.balances.length > 0);
}

/**
 * Names of the groups a total is leaving out, deduplicated and sorted.
 *
 * The note says which ones by name. "Some totals are excluded" sends you
 * hunting for which, and the point of the flag is that you chose these.
 */
export function excludedGroupNames(breakdowns: readonly CountableBucket[][]): string[] {
  const names = new Set<string>();
  for (const breakdown of breakdowns) {
    for (const bucket of excludedBuckets(breakdown)) {
      names.add(bucket.groupName?.trim() || "Unnamed group");
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** "Amex", "Amex and Rent", "Amex, Rent and Tabs". */
export function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
