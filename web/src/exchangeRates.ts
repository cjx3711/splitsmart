/**
 * Live exchange rates for display only.
 *
 * Fetched client-side from Frankfurter and held in memory. Never written to
 * the database, never sent back to the server, never used to compute a
 * balance. The ledger stays a stack of per-currency amounts; these numbers
 * exist so a person looking at yen and dollars at once can see an estimate
 * of "what that would be in my preferred currency", labeled as such.
 *
 * On failure there is no fallback of 1. A 1:1 conversion is worse than no
 * conversion, so callers hide the estimate rather than show a wrong number.
 */
import { useEffect, useState } from "react";

const FRANKFURTER = "https://api.frankfurter.dev/v1/latest";

interface CachedRates {
  rates: Record<string, number>;
  date: string;
}

const cache = new Map<string /* base */, CachedRates>();
const inflight = new Map<string, Promise<CachedRates>>();

function neededSymbols(base: string, symbols: string[]): string[] {
  const upperBase = base.toUpperCase();
  return [
    ...new Set(
      symbols
        .map((s) => s.toUpperCase())
        .filter((s) => s && s !== upperBase),
    ),
  ].sort();
}

function cacheCovers(base: string, symbols: string[]): CachedRates | null {
  const entry = cache.get(base);
  if (!entry) return null;
  return symbols.every((s) => s in entry.rates) ? entry : null;
}

async function fetchRates(base: string, symbols: string[]): Promise<CachedRates> {
  const url = new URL(FRANKFURTER);
  url.searchParams.set("base", base);
  url.searchParams.set("symbols", symbols.join(","));

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Frankfurter ${res.status}`);
  const body = (await res.json()) as { date?: string; rates?: Record<string, number> };
  if (!body.date || !body.rates) throw new Error("Malformed rates response");
  return { rates: body.rates, date: body.date };
}

export function convertMinor(
  minor: number,
  fromCode: string,
  toCode: string,
  rates: Record<string, number>,
  decimalsFor: (code: string) => number | null,
): number | null {
  if (fromCode === toCode) return minor;
  const fromDec = decimalsFor(fromCode);
  const toDec = decimalsFor(toCode);
  if (fromDec === null || toDec === null) return null;
  const rate = rates[fromCode];
  if (rate == null || rate === 0) return null;
  const fromMajor = minor / 10 ** fromDec;
  const toMajor = fromMajor / rate;
  return Math.round(toMajor * 10 ** toDec);
}

export function convertBalances(
  balances: Array<{ currencyCode: string; amountMinor: number }>,
  toCode: string,
  rates: Record<string, number>,
  decimalsFor: (code: string) => number | null,
): number | null {
  let total = 0;
  for (const b of balances) {
    const converted = convertMinor(b.amountMinor, b.currencyCode, toCode, rates, decimalsFor);
    if (converted === null) return null;
    total += converted;
  }
  return total;
}

export function useExchangeRates(
  base: string,
  symbols: string[],
): {
  rates: Record<string, number> | null;
  date: string | null;
  loading: boolean;
  error: boolean;
} {
  const baseCode = base.trim().toUpperCase();
  const needed = neededSymbols(baseCode, symbols);
  const neededKey = needed.join(",");

  const [state, setState] = useState<{
    rates: Record<string, number> | null;
    date: string | null;
    loading: boolean;
    error: boolean;
  }>(() => {
    if (!baseCode || needed.length === 0) {
      return { rates: {}, date: null, loading: false, error: false };
    }
    const hit = cacheCovers(baseCode, needed);
    if (hit) return { rates: hit.rates, date: hit.date, loading: false, error: false };
    return { rates: null, date: null, loading: true, error: false };
  });

  useEffect(() => {
    if (!baseCode || needed.length === 0) {
      setState({ rates: {}, date: null, loading: false, error: false });
      return;
    }

    const hit = cacheCovers(baseCode, needed);
    if (hit) {
      setState({ rates: hit.rates, date: hit.date, loading: false, error: false });
      return;
    }

    const cached = cache.get(baseCode);
    const union = cached
      ? [...new Set([...Object.keys(cached.rates), ...needed])].sort()
      : needed;
    const key = `${baseCode}:${union.join(",")}`;

    let cancelled = false;
    setState({ rates: null, date: null, loading: true, error: false });

    let promise = inflight.get(key);
    if (!promise) {
      promise = fetchRates(baseCode, union)
        .then((result) => {
          const previous = cache.get(baseCode);
          const merged = {
            date: result.date,
            rates: { ...(previous?.rates ?? {}), ...result.rates },
          };
          cache.set(baseCode, merged);
          inflight.delete(key);
          return merged;
        })
        .catch((err: unknown) => {
          inflight.delete(key);
          throw err;
        });
      inflight.set(key, promise);
    }

    promise
      .then((result) => {
        if (!cancelled) setState({ rates: result.rates, date: result.date, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ rates: null, date: null, loading: false, error: true });
      });

    return () => {
      cancelled = true;
    };
    // neededKey is the stable serialisation of `needed`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseCode, neededKey]);

  return state;
}
