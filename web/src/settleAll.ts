/**
 * "Settle all" for one friend: close every group / one-on-one bucket whose
 * currency already nets to zero overall, with a payment that moves no money.
 *
 * The plan itself is src/domain/settle.ts's `planSettleAll`, the same module
 * the offline mirror already uses for simplify-debts, so this cannot drift
 * from the server's idea of which buckets are actually settled.
 */
import type { CurrencyAmount } from "./api.ts";

export const SETTLE_ALL_NOTE =
  "No money was exchanged. This balance already nets to zero across your other shared history, so this closes it out to match.";

/** `balances` with `deltaMinor` added to one currency, dropping it if it lands on zero. */
export function applyBalanceDelta(
  balances: CurrencyAmount[],
  currencyCode: string,
  deltaMinor: number,
): CurrencyAmount[] {
  const existing = balances.find((b) => b.currencyCode === currencyCode);
  const amountMinor = (existing?.amountMinor ?? 0) + deltaMinor;
  const next = balances.filter((b) => b.currencyCode !== currencyCode);
  if (amountMinor !== 0) next.push({ currencyCode, amountMinor });
  return next;
}

/** The currencies these transfers close out, in the order they were planned. */
export function cancellingCurrencies(transfers: Array<{ currencyCode: string }>): string[] {
  return [...new Set(transfers.map((t) => t.currencyCode))];
}

/** `A`, `A or B`, `A, B or C` - a negation reads better with "or" than "and". */
function orList(items: string[]): string {
  if (items.length < 2) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/**
 * The sentence offering "Close them out", NAMING THE CURRENCIES it is about.
 *
 * `planSettleAll` cancels per currency, which is the only thing it could do
 * (rule 2: currencies are never converted). So a friend can have JPY netting
 * to zero across a group and the one-on-one bucket while still owing hundreds
 * of USD. This used to say "nothing is owed overall" flat out, directly under
 * a balance reading "Hubert owes you 208.86 USD", which reads as the page
 * contradicting itself.
 */
export function settleAllHint(transfers: Array<{ currencyCode: string }>): string {
  const codes = cancellingCurrencies(transfers);
  const scope = `nothing is owed in ${orList(codes)} overall`;
  if (transfers.length === 1) {
    return `One ${codes[0]} balance below cancels out elsewhere, so ${scope} - but it still reads as unsettled on its own.`;
  }
  const subject = codes.length === 1 ? `${transfers.length} ${codes[0]} balances` : `${transfers.length} balances`;
  return `${subject} below cancel each other out, so ${scope} - but each still reads as unsettled on its own.`;
}
