/**
 * Turn several per-currency friend balances into one currency.
 *
 * The ledger never stores a rate (rule 2). A conversion is a pair of ordinary
 * payments per source currency: one that closes that ledger, and one that
 * opens the same debt in the target. Net positions stay the same; only the
 * pairing currency changes. Group bills are left alone — these payments are
 * one-on-one.
 *
 * Rates are a client-side hint, the same ones the ≈ estimate uses. A missing
 * rate or a conversion that rounds to zero refuses the whole plan rather than
 * settling one side and inventing nothing on the other.
 */
import { convertMinor } from "./exchangeRates.ts";
import type { CurrencyAmount } from "./api.ts";

export const CONVERSION_DESCRIPTION = "Balance conversion";

export type ConversionPayment = {
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
  currencyCode: string;
  description: string;
  details: string;
  /** Posted on the payment so the thread says this was automatic, and at what rate. */
  comment: string;
};

/** How many target units one source unit became, trimmed of a long tail. */
export function formatQuotedRate(
  sourceMinor: number,
  sourceCode: string,
  targetMinor: number,
  targetCode: string,
  decimalsFor: (code: string) => number | null,
): string | null {
  const fromDec = decimalsFor(sourceCode);
  const toDec = decimalsFor(targetCode);
  if (fromDec === null || toDec === null || sourceMinor === 0) return null;
  const perOne = targetMinor / 10 ** toDec / (sourceMinor / 10 ** fromDec);
  if (!Number.isFinite(perOne) || perOne <= 0) return null;
  const digits = perOne >= 100 ? 2 : perOne >= 1 ? 4 : 6;
  const body = perOne.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return `1 ${sourceCode} = ${body} ${targetCode}`;
}

export function conversionNote(opts: {
  sourceLabel: string;
  sourceCode: string;
  targetLabel: string;
  targetCode: string;
  rate: string | null;
  rateDate: string;
}): string {
  const pair = `${opts.sourceLabel} ${opts.sourceCode} → ${opts.targetLabel} ${opts.targetCode}`;
  const rate = opts.rate ? ` at ${opts.rate}` : "";
  return `Automatic balance conversion: ${pair}${rate}, using the ${opts.rateDate} rate.`;
}

export type ConversionLeg = {
  sourceCode: string;
  sourceMinor: number;
  targetCode: string;
  targetMinor: number;
  theyOwe: boolean;
};

export type ConversionPlan =
  | {
      ok: true;
      legs: ConversionLeg[];
      payments: ConversionPayment[];
      resultMinor: number;
    }
  | { ok: false; reason: "missing_rate" | "rounds_to_zero"; currencyCode: string };

export function planBalanceConversion(opts: {
  balances: CurrencyAmount[];
  targetCode: string;
  rates: Record<string, number>;
  decimalsFor: (code: string) => number | null;
  youId: string;
  themId: string;
  rateDate: string;
  formatAmount: (minor: number, code: string) => string | null;
}): ConversionPlan {
  const target = opts.targetCode.toUpperCase();
  const legs: ConversionLeg[] = [];
  const payments: ConversionPayment[] = [];
  let resultMinor = 0;

  for (const balance of opts.balances) {
    if (balance.amountMinor === 0) continue;
    const source = balance.currencyCode.toUpperCase();
    if (source === target) {
      resultMinor += balance.amountMinor;
      continue;
    }

    const sourceAbs = Math.abs(balance.amountMinor);
    const converted = convertMinor(sourceAbs, source, target, opts.rates, opts.decimalsFor);
    if (converted === null) {
      return { ok: false, reason: "missing_rate", currencyCode: source };
    }
    if (converted === 0) {
      return { ok: false, reason: "rounds_to_zero", currencyCode: source };
    }

    const theyOwe = balance.amountMinor > 0;
    resultMinor += theyOwe ? converted : -converted;

    const fromLabel = opts.formatAmount(sourceAbs, source) ?? String(sourceAbs);
    const toLabel = opts.formatAmount(converted, target) ?? String(converted);
    const rate = formatQuotedRate(sourceAbs, source, converted, target, opts.decimalsFor);
    const note = conversionNote({
      sourceLabel: fromLabel,
      sourceCode: source,
      targetLabel: toLabel,
      targetCode: target,
      rate,
      rateDate: opts.rateDate,
    });

    legs.push({
      sourceCode: source,
      sourceMinor: sourceAbs,
      targetCode: target,
      targetMinor: converted,
      theyOwe,
    });

    const debtor = theyOwe ? opts.themId : opts.youId;
    const creditor = theyOwe ? opts.youId : opts.themId;
    payments.push(
      {
        fromUserId: debtor,
        toUserId: creditor,
        amountMinor: sourceAbs,
        currencyCode: source,
        description: CONVERSION_DESCRIPTION,
        details: note,
        comment: note,
      },
      {
        fromUserId: creditor,
        toUserId: debtor,
        amountMinor: converted,
        currencyCode: target,
        description: CONVERSION_DESCRIPTION,
        details: note,
        comment: note,
      },
    );
  }

  return { ok: true, legs, payments, resultMinor };
}
