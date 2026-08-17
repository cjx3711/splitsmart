/**
 * Currency-aware money rendering.
 *
 * Decimal places come from the `currencies` table, fetched once and held here.
 * Nothing in the UI may assume 2 — JPY is 0, KWD is 3, BTC is 8, and a wrong
 * guess moves the decimal point on someone's balance.
 *
 * Until the table has loaded, amounts render as a dash rather than a
 * provisionally-wrong number.
 */
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, formatMoney, parseMoney, type Currency, type CurrencyAmount } from "./api.ts";

interface CurrencyContextValue {
  currencies: Currency[];
  loaded: boolean;
  decimalsFor: (code: string) => number | null;
  /** This user's own most-used currencies, most-used first. Empty when signed out or unused. */
  frequentCodes: string[];
}

const CurrencyContext = createContext<CurrencyContextValue>({
  currencies: [],
  loaded: false,
  decimalsFor: () => null,
  frequentCodes: [],
});

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [frequentCodes, setFrequentCodes] = useState<string[]>([]);

  useEffect(() => {
    api
      .listCurrencies()
      .then((r) => setCurrencies(r.currencies))
      .catch(() => setCurrencies([]))
      .finally(() => setLoaded(true));
    // Fails silently when signed out — the picker just falls back to a
    // popular-currencies default in that case.
    api
      .frequentCurrencies()
      .then((r) => setFrequentCodes(r.codes))
      .catch(() => setFrequentCodes([]));
  }, []);

  const value = useMemo<CurrencyContextValue>(() => {
    const byCode = new Map(currencies.map((c) => [c.code, c.decimal_places]));
    return {
      currencies,
      loaded,
      decimalsFor: (code) => byCode.get(code.toUpperCase()) ?? null,
      frequentCodes,
    };
  }, [currencies, loaded, frequentCodes]);

  return <CurrencyContext.Provider value={value}>{children}</CurrencyContext.Provider>;
}

export function useCurrencies() {
  return useContext(CurrencyContext);
}

/** Formats an amount, or returns null if the currency isn't known yet. */
export function useFormatMoney() {
  const { decimalsFor } = useCurrencies();
  return (minor: number, currencyCode: string): string | null => {
    const decimals = decimalsFor(currencyCode);
    return decimals === null ? null : formatMoney(minor, decimals);
  };
}

/** Parses user input for a specific currency. Throws like the server does. */
export function useParseMoney() {
  const { decimalsFor } = useCurrencies();
  return (input: string, currencyCode: string): number => {
    const decimals = decimalsFor(currencyCode);
    if (decimals === null) throw new Error(`Unknown currency: ${currencyCode}`);
    return parseMoney(input, decimals);
  };
}

/** A single amount with its currency code. Always tabular figures. */
export function Amount({
  minor,
  currency,
  signed = false,
  absolute = false,
}: {
  minor: number;
  currency: string;
  /** Colour by sign: green when owed to you, coral when you owe. */
  signed?: boolean;
  /** Drop the minus sign — for use next to "you owe" / "owes you" wording. */
  absolute?: boolean;
}) {
  const format = useFormatMoney();
  const text = format(absolute ? Math.abs(minor) : minor, currency);
  const tone = !signed ? "" : minor >= 0 ? "positive" : "negative";

  return (
    <span className={`amount ${tone}`.trim()}>
      {text ?? "—"}
      <span className="code">{currency}</span>
    </span>
  );
}

/**
 * Several amounts on one line.
 *
 * Always use this rather than mapping <Amount> inline: two currencies rendered
 * back to back read as a single number.
 */
export function Amounts({
  balances,
  signed = false,
  absolute = false,
}: {
  balances: CurrencyAmount[];
  signed?: boolean;
  absolute?: boolean;
}) {
  return (
    <span className="amounts">
      {balances.map((b) => (
        <Amount
          key={b.currencyCode}
          minor={b.amountMinor}
          currency={b.currencyCode}
          signed={signed}
          absolute={absolute}
        />
      ))}
    </span>
  );
}

/**
 * The per-currency ledger.
 *
 * Deliberately a list, not a total. Currencies are separate ledgers here and
 * there is no exchange-rate table to collapse them with — see
 * src/domain/balances.ts. Anything that looks like a single grand total across
 * currencies is a bug.
 */
export function Ledger({
  balances,
  signed = true,
  empty = "settled up",
}: {
  balances: CurrencyAmount[];
  signed?: boolean;
  empty?: string;
}) {
  if (balances.length === 0) return <span className="muted">{empty}</span>;

  return (
    <div className="ledger">
      {balances.map((b) => (
        <div key={b.currencyCode} className="ledger-row">
          <Amount minor={b.amountMinor} currency={b.currencyCode} signed={signed} />
        </div>
      ))}
    </div>
  );
}

/** Adds up amounts per currency without ever crossing between them. */
export function sumByCurrency(entries: CurrencyAmount[]): CurrencyAmount[] {
  const totals = new Map<string, number>();
  for (const e of entries) {
    totals.set(e.currencyCode, (totals.get(e.currencyCode) ?? 0) + e.amountMinor);
  }
  return [...totals.entries()]
    .filter(([, amount]) => amount !== 0)
    .map(([currencyCode, amountMinor]) => ({ currencyCode, amountMinor }))
    .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}
