import { Amount, useCurrencies } from "./money.tsx";
import { convertBalances, useExchangeRates } from "./exchangeRates.ts";
import type { CurrencyAmount } from "./api.ts";

export function ConversionNote({ code, date }: { code: string; date: string }) {
  return (
    <p className="conversion-note">
      * Converted to {code} using{" "}
      <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">
        Rates By Exchange Rate API
      </a>
      , as of {date}. This is an estimate for display only - balances are tracked separately per
      currency.
    </p>
  );
}

/**
 * The "≈ … overall*" line. Renders nothing unless there are ≥2 currencies and
 * rates loaded successfully - never a stale or 1:1 stand-in.
 */
export function EstimatedTotal({
  balances,
  preferredCurrency,
}: {
  balances: CurrencyAmount[];
  preferredCurrency: string;
}) {
  const { decimalsFor } = useCurrencies();
  const symbols = balances.length >= 2 ? balances.map((b) => b.currencyCode) : [];
  const { rates, loading, error } = useExchangeRates(preferredCurrency, symbols);
  if (balances.length < 2 || loading || error || !rates) return null;
  const total = convertBalances(balances, preferredCurrency, rates, decimalsFor);
  if (total === null) return null;
  return (
    <div className="estimate">
      ≈ <Amount minor={total} currency={preferredCurrency} signed /> overall*
    </div>
  );
}

/**
 * One shared footnote for a page (or a section). Shows only when at least one
 * of the supplied balance sets would actually render an estimate.
 */
export function ConversionFootnote({
  sets,
  preferredCurrency,
}: {
  sets: CurrencyAmount[][];
  preferredCurrency: string;
}) {
  const { decimalsFor } = useCurrencies();
  const needed = sets.some((s) => s.length > 1);
  const symbols = [...new Set(sets.flatMap((s) => s.map((b) => b.currencyCode)))];
  const { rates, date, loading, error } = useExchangeRates(
    preferredCurrency,
    needed ? symbols : [],
  );
  if (!needed || !date || loading || error || !rates) return null;
  const any = sets.some(
    (s) => s.length > 1 && convertBalances(s, preferredCurrency, rates, decimalsFor) !== null,
  );
  if (!any) return null;
  return <ConversionNote code={preferredCurrency} date={date} />;
}
