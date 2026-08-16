/**
 * The split engine.
 *
 * Turns "who is involved and how should this be divided" into concrete
 * per-person `paid_share` / `owed_share` amounts, then derives the pairwise
 * repayments those shares imply.
 *
 * This module is PURE — no database, no I/O, no clock. That is deliberate: it
 * is the piece most likely to be wrong in a way nobody notices for months, so
 * it must be trivially testable. See split.test.ts.
 */
import { MoneyError, splitEvenly, splitByWeights } from "./money.ts";

export type SplitType = "equal" | "exact" | "percent" | "shares" | "adjustment";

export interface SplitParticipant {
  userId: number;
  /** How much cash this person actually put in, in minor units. */
  paidMinor: number;
  /**
   * Meaning depends on the split type:
   *   equal      — ignored
   *   exact      — this person's owed amount, in minor units
   *   percent    — percentage of the total (0-100)
   *   shares     — number of shares (any positive number)
   *   adjustment — fixed amount, in minor units, applied before the even split
   */
  input?: number;
}

export interface SplitResult {
  userId: number;
  paidMinor: number;
  owedMinor: number;
  /** Preserved so the UI can reopen the expense in the editor the user used. */
  input: number | null;
}

export interface Repayment {
  fromUserId: number; // debtor
  toUserId: number; // creditor
  amountMinor: number;
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
): SplitResult[] {
  if (participants.length === 0) {
    throw new SplitError("An expense needs at least one participant");
  }
  if (!Number.isInteger(totalMinor) || totalMinor < 0) {
    throw new SplitError(`Invalid total: ${totalMinor}`);
  }

  const seen = new Set<number>();
  for (const p of participants) {
    if (seen.has(p.userId)) {
      throw new SplitError(`Duplicate participant: user ${p.userId}`);
    }
    seen.add(p.userId);
  }

  const sorted = [...participants].sort((a, b) => a.userId - b.userId);

  const paidTotal = sorted.reduce((sum, p) => sum + p.paidMinor, 0);
  if (paidTotal !== totalMinor) {
    throw new SplitError(
      `Payments (${paidTotal}) do not add up to the expense total (${totalMinor})`,
    );
  }

  const owed = computeOwedShares(totalMinor, splitType, sorted);

  const owedTotal = owed.reduce((a, b) => a + b, 0);
  if (owedTotal !== totalMinor) {
    // Unreachable if the helpers below are correct — kept as a loud tripwire
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

    default: {
      const exhaustive: never = splitType;
      throw new SplitError(`Unknown split type: ${String(exhaustive)}`);
    }
  }
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
 * balance queries stay a plain SUM. It is a cache derived from expense_users —
 * if the two ever disagree, expense_users wins. `npm run db:check` verifies it.
 */
export function deriveRepayments(shares: SplitResult[]): Repayment[] {
  const creditors: Array<{ userId: number; amount: number }> = [];
  const debtors: Array<{ userId: number; amount: number }> = [];

  for (const s of shares) {
    const net = s.paidMinor - s.owedMinor;
    if (net > 0) creditors.push({ userId: s.userId, amount: net });
    else if (net < 0) debtors.push({ userId: s.userId, amount: -net });
  }

  // Largest amounts first; userId breaks ties so ordering never depends on the
  // caller's array order.
  creditors.sort((a, b) => b.amount - a.amount || a.userId - b.userId);
  debtors.sort((a, b) => b.amount - a.amount || a.userId - b.userId);

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
  payerId: number,
  participantIds: number[],
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
