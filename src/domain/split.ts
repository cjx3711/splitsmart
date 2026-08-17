/**
 * The split engine.
 *
 * Turns "who is involved and how should this be divided" into concrete
 * per-person `paid_share` / `owed_share` amounts, then derives the pairwise
 * repayments those shares imply.
 *
 * This module is PURE: no database, no I/O, no clock. That is deliberate: it
 * is the piece most likely to be wrong in a way nobody notices for months, so
 * it must be trivially testable. See split.test.ts.
 */
import { MoneyError, splitEvenly, splitByWeights } from "./money.ts";

export type SplitType =
  | "equal"
  | "exact"
  | "percent"
  | "shares"
  | "adjustment"
  | "itemized";

export interface SplitParticipant {
  userId: string;
  /** How much cash this person actually put in, in minor units. */
  paidMinor: number;
  /**
   * Meaning depends on the split type:
   *   equal      (ignored)
   *   exact      (this person's owed amount, in minor units
   *   percent    (percentage of the total (0-100)
   *   shares     (number of shares (any positive number)
   *   adjustment (fixed amount, in minor units, applied before the even split
   *   itemized   (ignored; the line items carry the detail
   */
  input?: number;
}

/**
 * One line of an itemized bill.
 *
 * Unlike the other split types, itemization cannot be expressed as one number
 * per person: the same expense has several lines, each shared by a different
 * subset of the table. So it travels alongside the participants rather than
 * inside them, and is persisted as JSON in `expenses.split_meta`; the derived
 * per-person totals still land in `expense_users` like every other split, so
 * balances never have to know itemization exists.
 */
export interface SplitItem {
  /** Free text for the UI ("Ramen", "Bottle of wine"). Never used in maths. */
  label?: string | null;
  amountMinor: number;
  /** Who shared this line. Must be a subset of the expense's participants. */
  participantIds: string[];
}

export interface SplitOptions {
  /** Required for `itemized`, rejected for every other type. */
  items?: SplitItem[];
}

export interface SplitResult {
  userId: string;
  paidMinor: number;
  owedMinor: number;
  /** Preserved so the UI can reopen the expense in the editor the user used. */
  input: number | null;
}

export interface Repayment {
  fromUserId: string; // debtor
  toUserId: string; // creditor
  amountMinor: number;
}

/** Lexicographic `<` on ULIDs (and any other string id). Not localeCompare. */
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class SplitError extends Error {}

/**
 * Computes owed shares for an expense.
 *
 * Guarantees on success:
 *   sum(paidMinor) === totalMinor
 *   sum(owedMinor) === totalMinor
 *
 * Participants are sorted by userId before any remainder is allocated, so the
 * output is stable across calls regardless of input ordering.
 */
export function computeSplit(
  totalMinor: number,
  splitType: SplitType,
  participants: SplitParticipant[],
  options: SplitOptions = {},
): SplitResult[] {
  if (participants.length === 0) {
    throw new SplitError("An expense needs at least one participant");
  }
  if (!Number.isInteger(totalMinor) || totalMinor < 0) {
    throw new SplitError(`Invalid total: ${totalMinor}`);
  }

  const seen = new Set<string>();
  for (const p of participants) {
    if (seen.has(p.userId)) {
      throw new SplitError(`Duplicate participant: user ${p.userId}`);
    }
    seen.add(p.userId);
  }

  const sorted = [...participants].sort((a, b) => compareIds(a.userId, b.userId));

  const paidTotal = sorted.reduce((sum, p) => sum + p.paidMinor, 0);
  if (paidTotal !== totalMinor) {
    throw new SplitError(
      `Payments (${paidTotal}) do not add up to the expense total (${totalMinor})`,
    );
  }

  if (splitType !== "itemized" && options.items !== undefined) {
    throw new SplitError(`Line items are only meaningful for an itemized split`);
  }

  const owed = computeOwedShares(totalMinor, splitType, sorted, options);

  // `expense_users.owed_share_minor` has a CHECK (>= 0), so a negative share
  // would fail at INSERT time with an opaque constraint error. A negative
  // adjustment large enough to overshoot an even share is the realistic way to
  // get here, and the person who typed it deserves to be told which one.
  const negative = owed.findIndex((o) => o < 0);
  if (negative !== -1) {
    throw new SplitError(
      `This split leaves user ${sorted[negative]?.userId} owing a negative amount`,
    );
  }

  const owedTotal = owed.reduce((a, b) => a + b, 0);
  if (owedTotal !== totalMinor) {
    // Unreachable if the helpers below are correct; kept as a loud tripwire
    // because a silent failure here corrupts balances permanently.
    throw new SplitError(
      `Internal: owed shares summed to ${owedTotal}, expected ${totalMinor}`,
    );
  }

  return sorted.map((p, i) => ({
    userId: p.userId,
    paidMinor: p.paidMinor,
    owedMinor: owed[i] ?? 0,
    input: p.input ?? null,
  }));
}

function computeOwedShares(
  totalMinor: number,
  splitType: SplitType,
  sorted: SplitParticipant[],
  options: SplitOptions,
): number[] {
  switch (splitType) {
    case "equal":
      return splitEvenly(totalMinor, sorted.length);

    case "exact": {
      const shares = sorted.map((p) => requireInput(p, "exact"));
      if (shares.some((s) => !Number.isInteger(s) || s < 0)) {
        throw new SplitError("Exact shares must be non-negative whole minor units");
      }
      const sum = shares.reduce((a, b) => a + b, 0);
      if (sum !== totalMinor) {
        throw new SplitError(
          `Exact shares add up to ${sum}, but the expense total is ${totalMinor}`,
        );
      }
      return shares;
    }

    case "percent": {
      const percents = sorted.map((p) => requireInput(p, "percent"));
      if (percents.some((p) => p < 0)) {
        throw new SplitError("Percentages must be non-negative");
      }
      const sum = percents.reduce((a, b) => a + b, 0);
      // Tolerance covers users typing 33.33/33.33/33.34 style splits.
      if (Math.abs(sum - 100) > 0.01) {
        throw new SplitError(`Percentages add up to ${sum}, expected 100`);
      }
      return splitByWeights(totalMinor, percents);
    }

    case "shares": {
      const shares = sorted.map((p) => requireInput(p, "shares"));
      if (shares.some((s) => s < 0)) {
        throw new SplitError("Share counts must be non-negative");
      }
      return splitByWeights(totalMinor, shares);
    }

    case "adjustment": {
      // Each person is assigned their fixed adjustment first (e.g. one person's
      // extra drink), then whatever is left over is split evenly.
      const adjustments = sorted.map((p) => p.input ?? 0);
      if (adjustments.some((a) => !Number.isInteger(a))) {
        throw new SplitError("Adjustments must be whole minor units");
      }
      const adjustmentTotal = adjustments.reduce((a, b) => a + b, 0);
      const remainder = totalMinor - adjustmentTotal;
      if (remainder < 0) {
        throw new SplitError(
          `Adjustments (${adjustmentTotal}) exceed the expense total (${totalMinor})`,
        );
      }
      const even = splitEvenly(remainder, sorted.length);
      return adjustments.map((a, i) => a + (even[i] ?? 0));
    }

    case "itemized":
      return computeItemizedShares(totalMinor, sorted, options.items);

    default: {
      const exhaustive: never = splitType;
      throw new SplitError(`Unknown split type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Splits an itemized bill.
 *
 * Two passes:
 *
 *   1. Each line is split evenly among the people who shared it. This uses the
 *      same `splitEvenly` as an equal split, over the line's participants in
 *      userId order, so a line's odd cent always lands on the same person.
 *
 *   2. Whatever the lines do not account for (tax, tip, service charge, the
 *      cover you did not itemise) is shared in proportion to what each person
 *      already owes from step 1. That is what proportional tax actually means:
 *      the person who ordered the lobster pays more of the 10% service charge
 *      than the person who had soup.
 *
 * The fallback matters: if every line is zero (or the whole bill is nothing but
 * a service charge), there are no weights to be proportional to, so the extra
 * splits evenly rather than throwing.
 *
 * The lines are allowed to under-shoot the total but never to overshoot; a
 * bill whose items exceed the amount charged is a data-entry error, and
 * silently scaling it down would hide that.
 */
function computeItemizedShares(
  totalMinor: number,
  sorted: SplitParticipant[],
  items: SplitItem[] | undefined,
): number[] {
  if (!items || items.length === 0) {
    throw new SplitError("An itemized split needs at least one line item");
  }

  const indexOf = new Map(sorted.map((p, i) => [p.userId, i]));
  const owed = new Array<number>(sorted.length).fill(0);
  let itemTotal = 0;

  for (const [n, item] of items.entries()) {
    const where = `Item ${n + 1}${item.label ? ` (${item.label})` : ""}`;

    if (!Number.isInteger(item.amountMinor) || item.amountMinor < 0) {
      throw new SplitError(`${where} must be a non-negative whole minor unit amount`);
    }
    if (item.participantIds.length === 0) {
      throw new SplitError(`${where} has nobody sharing it`);
    }

    // Sorted so the leftover minor unit is allocated deterministically, and
    // deduped so listing someone twice cannot quietly double their share.
    const sharers = [...new Set(item.participantIds)].sort(compareIds);
    if (sharers.length !== item.participantIds.length) {
      throw new SplitError(`${where} lists the same person more than once`);
    }

    const portions = splitEvenly(item.amountMinor, sharers.length);
    for (const [k, userId] of sharers.entries()) {
      const at = indexOf.get(userId);
      if (at === undefined) {
        throw new SplitError(`${where} includes user ${userId}, who is not on this expense`);
      }
      owed[at] = (owed[at] ?? 0) + (portions[k] ?? 0);
    }

    itemTotal += item.amountMinor;
  }

  const extra = totalMinor - itemTotal;
  if (extra < 0) {
    throw new SplitError(
      `Line items add up to ${itemTotal}, which is more than the expense total (${totalMinor})`,
    );
  }
  if (extra === 0) return owed;

  const spread = owed.some((o) => o > 0)
    ? splitByWeights(extra, owed)
    : splitEvenly(extra, sorted.length);

  return owed.map((o, i) => o + (spread[i] ?? 0));
}

function requireInput(p: SplitParticipant, type: SplitType): number {
  if (p.input === undefined || p.input === null) {
    throw new SplitError(`User ${p.userId} is missing a value for a ${type} split`);
  }
  if (!Number.isFinite(p.input)) {
    throw new SplitError(`User ${p.userId} has a non-finite ${type} value`);
  }
  return p.input;
}

/**
 * Derives who-owes-whom from per-person net positions.
 *
 * Each participant's net is (paid - owed): positive means they are owed money,
 * negative means they owe. Creditors and debtors are then matched greedily,
 * largest first, which produces the minimum number of transfers for a single
 * expense and is deterministic given a stable sort.
 *
 * This is computed once at write time and stored in expense_repayments so that
 * balance queries stay a plain SUM. It is a cache derived from expense_users -
 * if the two ever disagree, expense_users wins. `yarn db:check` verifies it.
 */
export function deriveRepayments(shares: SplitResult[]): Repayment[] {
  const creditors: Array<{ userId: string; amount: number }> = [];
  const debtors: Array<{ userId: string; amount: number }> = [];

  for (const s of shares) {
    const net = s.paidMinor - s.owedMinor;
    if (net > 0) creditors.push({ userId: s.userId, amount: net });
    else if (net < 0) debtors.push({ userId: s.userId, amount: -net });
  }

  // Largest amounts first; userId breaks ties so ordering never depends on the
  // caller's array order.
  creditors.sort((a, b) => b.amount - a.amount || compareIds(a.userId, b.userId));
  debtors.sort((a, b) => b.amount - a.amount || compareIds(a.userId, b.userId));

  const repayments: Repayment[] = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci]!;
    const debtor = debtors[di]!;
    const amount = Math.min(creditor.amount, debtor.amount);

    if (amount > 0) {
      repayments.push({
        fromUserId: debtor.userId,
        toUserId: creditor.userId,
        amountMinor: amount,
      });
    }

    creditor.amount -= amount;
    debtor.amount -= amount;
    if (creditor.amount === 0) ci++;
    if (debtor.amount === 0) di++;
  }

  return repayments;
}

/**
 * Convenience wrapper for the overwhelmingly common case: one person paid the
 * whole thing and it is split evenly among everyone.
 */
export function simpleEqualSplit(
  totalMinor: number,
  payerId: string,
  participantIds: string[],
): SplitResult[] {
  if (!participantIds.includes(payerId)) {
    throw new SplitError("The payer must be one of the participants");
  }
  return computeSplit(
    totalMinor,
    "equal",
    participantIds.map((userId) => ({
      userId,
      paidMinor: userId === payerId ? totalMinor : 0,
    })),
  );
}

export { MoneyError };
