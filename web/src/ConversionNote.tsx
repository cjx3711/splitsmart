import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Amount, useCurrencies } from "./money.tsx";
import { convertBalances, needsConversion, useExchangeRates } from "./exchangeRates.ts";
import type { CurrencyAmount } from "./api.ts";

/**
 * The footnote every ≈ estimate points at.
 *
 * It names the currency as YOUR DEFAULT rather than just "USD": the code is not
 * a property of the ledger (rule 2 - currencies are never converted), it is a
 * display preference, and someone reading a total in the wrong currency has no
 * way to guess that from a bare code. Logged-in screens pass `settingsHref` so
 * the sentence also says where to change it; the guest shell has no settings
 * page, so there it stays a plain statement of what was used.
 */
export function ConversionNote({
  code,
  date,
  settingsHref,
}: {
  code: string;
  date: string;
  settingsHref?: string;
}) {
  return (
    <p className="conversion-note">
      * Converted to {code}, your default currency, using{" "}
      <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">
        Rates By Exchange Rate API
      </a>
      , as of {date}. This is an estimate for display only - balances are tracked separately per
      currency.
      {settingsHref !== undefined && (
        <>
          {" "}
          <Link to={settingsHref}>Change your default currency</Link>.
        </>
      )}
    </p>
  );
}

/**
 * Converted total in the preferred currency, or null when conversion is not
 * needed / not possible. Shared by the ≈ footnote and by collapsed headlines
 * so a missing rate never becomes a 1:1 stand-in.
 */
export function useConvertedTotal(
  balances: CurrencyAmount[],
  preferredCurrency: string,
): number | null {
  const { decimalsFor } = useCurrencies();
  const needed = needsConversion(balances, preferredCurrency);
  const symbols = needed ? balances.map((b) => b.currencyCode) : [];
  const { rates, loading, error } = useExchangeRates(preferredCurrency, symbols);
  if (!needed || loading || error || !rates) return null;
  return convertBalances(balances, preferredCurrency, rates, decimalsFor);
}

/**
 * The "≈ … *" line. Renders nothing unless some amount is not already in the
 * preferred currency and rates loaded successfully - never a stale or 1:1 stand-in.
 */
export function EstimatedTotal({
  balances,
  preferredCurrency,
  compact = false,
}: {
  balances: CurrencyAmount[];
  preferredCurrency: string;
  compact?: boolean;
}) {
  const total = useConvertedTotal(balances, preferredCurrency);
  if (total === null) return null;
  return (
    <div className={compact ? "estimate estimate-compact" : "estimate"}>
      ≈ <Amount minor={total} currency={preferredCurrency} signed />
      {compact ? "*" : " overall*"}
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
  settingsHref,
}: {
  sets: CurrencyAmount[][];
  preferredCurrency: string;
  /** Where to change the default currency. Omitted in the guest shell. */
  settingsHref?: string;
}) {
  const { decimalsFor } = useCurrencies();
  const needed = sets.some((s) => needsConversion(s, preferredCurrency));
  const symbols = [...new Set(sets.flatMap((s) => s.map((b) => b.currencyCode)))];
  const { rates, date, loading, error } = useExchangeRates(
    preferredCurrency,
    needed ? symbols : [],
  );
  if (!needed || !date || loading || error || !rates) return null;
  const any = sets.some(
    (s) =>
      needsConversion(s, preferredCurrency) &&
      convertBalances(s, preferredCurrency, rates, decimalsFor) !== null,
  );
  if (!any) return null;
  return <ConversionNote code={preferredCurrency} date={date} settingsHref={settingsHref} />;
}

/**
 * "You have several currencies here - want them in one?"
 *
 * The same nudge on a group's payment list and on a friend's balance card, so
 * the offer reads identically wherever someone meets it. It NAMES the currency
 * the dialog will open on and whose default that is: "convert into one
 * currency" without saying which sounds like the app choosing for you, and the
 * choice is not arbitrary - it is a setting the reader owns.
 *
 * `action` is the button, passed in rather than built here, because the friend
 * page wraps it in OnlineOnly and the group page simply omits it offline.
 */
export function ConvertBalancesHint({
  lead,
  target,
  action,
}: {
  /** The sentence that says what the situation is, ending in a full stop. */
  lead: string;
  /** Where the conversion lands: the code, and whose default currency it is. */
  target: { code: string; label: string };
  action: ReactNode;
}) {
  return (
    <p>
      {lead} {action} into {target.code}, {target.label}, and there is less to send.
    </p>
  );
}
