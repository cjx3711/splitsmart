/**
 * Live exchange rates for the ≈ estimate and for "convert balance".
 *
 * Fetched in the browser from Exchange Rate API and cached in localStorage
 * for a day. Never written to the database, never sent back as a rate, never
 * used to compute a stored balance. The ledger stays a stack of per-currency
 * amounts.
 *
 * Use `useExchangeRates` from any screen. Wrap the app in `ExchangeRatesProvider`
 * (tests pass `rates` / `date` and skip the network).
 *
 * A missing rate still never becomes 1: callers hide the estimate or refuse
 * the conversion rather than show a 1:1 stand-in.
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

const OPEN_ER = "https://open.er-api.com/v6/latest";
const STORAGE_PREFIX = "splitsmart.fx.v1:";
const TTL_MS = 24 * 60 * 60 * 1000;

interface CachedRates {
  rates: Record<string, number>;
  date: string;
  fetchedAt: number;
}

export type ExchangeRates = {
  rates: Record<string, number> | null;
  date: string | null;
  loading: boolean;
  error: boolean;
};

const memory = new Map<string /* base */, CachedRates>();
const inflight = new Map<string, Promise<CachedRates>>();

const HardcodedFx = createContext<{ rates: Record<string, number>; date: string } | null>(null);

function storage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

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

function readCache(base: string): CachedRates | null {
  const now = Date.now();
  const mem = memory.get(base);
  if (mem && now - mem.fetchedAt < TTL_MS) return mem;
  if (mem) memory.delete(base);

  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(STORAGE_PREFIX + base);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Partial<CachedRates>;
    if (
      !stored.rates ||
      typeof stored.rates !== "object" ||
      typeof stored.date !== "string" ||
      typeof stored.fetchedAt !== "number" ||
      now - stored.fetchedAt >= TTL_MS
    ) {
      store.removeItem(STORAGE_PREFIX + base);
      return null;
    }
    const entry = { rates: stored.rates, date: stored.date, fetchedAt: stored.fetchedAt };
    memory.set(base, entry);
    return entry;
  } catch {
    return null;
  }
}

function writeCache(base: string, entry: CachedRates): void {
  memory.set(base, entry);
  try {
    storage()?.setItem(STORAGE_PREFIX + base, JSON.stringify(entry));
  } catch {
    // Quota or private mode: memory still holds the day's rates.
  }
}

async function fetchRates(base: string): Promise<CachedRates> {
  const res = await fetch(`${OPEN_ER}/${encodeURIComponent(base)}`);
  if (!res.ok) throw new Error(`Exchange Rate API ${res.status}`);
  const body = (await res.json()) as {
    result?: string;
    rates?: Record<string, number>;
    time_last_update_unix?: number;
  };
  if (body.result !== "success" || !body.rates || typeof body.time_last_update_unix !== "number") {
    throw new Error("Malformed rates response");
  }
  return {
    rates: body.rates,
    date: new Date(body.time_last_update_unix * 1000).toISOString().slice(0, 10),
    fetchedAt: Date.now(),
  };
}

function loadRates(base: string): Promise<CachedRates> {
  const pending = inflight.get(base);
  if (pending) return pending;
  const promise = fetchRates(base)
    .then((result) => {
      writeCache(base, result);
      inflight.delete(base);
      return result;
    })
    .catch((err: unknown) => {
      inflight.delete(base);
      throw err;
    });
  inflight.set(base, promise);
  return promise;
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

/** True when at least one amount would actually move under `preferredCurrency`. */
export function needsConversion(
  balances: Array<{ currencyCode: string }>,
  preferredCurrency: string,
): boolean {
  const pref = preferredCurrency.toUpperCase();
  return balances.some((b) => b.currencyCode.toUpperCase() !== pref);
}

export type FriendColumn = "owe" | "owed" | "both" | "none";

/**
 * Which dashboard column a friend belongs in. Mixed-currency people can owe
 * you in one ledger and be owed in another; when a converted net is available
 * they appear once, on the side of that estimate. Without rates they still
 * show in both so neither side of the ledger is hidden.
 */
export function friendDashboardColumn(
  balances: Array<{ currencyCode: string; amountMinor: number }>,
  preferredCurrency: string,
  rates: Record<string, number> | null,
  decimalsFor: (code: string) => number | null,
): FriendColumn {
  const hasNeg = balances.some((b) => b.amountMinor < 0);
  const hasPos = balances.some((b) => b.amountMinor > 0);
  if (hasNeg && !hasPos) return "owe";
  if (hasPos && !hasNeg) return "owed";
  if (!hasNeg && !hasPos) return "none";
  if (rates) {
    const total = convertBalances(balances, preferredCurrency, rates, decimalsFor);
    if (total !== null) return total > 0 ? "owed" : "owe";
  }
  return "both";
}

/**
 * The global rates source. Mount once around the app. Tests pass `rates` (and
 * optionally `date`) so `useExchangeRates` returns that snapshot and never
 * fetches.
 */
export function ExchangeRatesProvider({
  children,
  rates,
  date = "2000-01-01",
}: {
  children: ReactNode;
  rates?: Record<string, number>;
  date?: string;
}) {
  const hardcoded = useMemo(
    () => (rates ? { rates, date } : null),
    [rates, date],
  );
  return createElement(HardcodedFx.Provider, { value: hardcoded }, children);
}

export function useExchangeRates(base: string, symbols: string[]): ExchangeRates {
  const hardcoded = useContext(HardcodedFx);
  const baseCode = base.trim().toUpperCase();
  const needed = neededSymbols(baseCode, symbols);
  const neededKey = needed.join(",");

  const [state, setState] = useState<ExchangeRates>(() => {
    if (hardcoded) {
      return { rates: hardcoded.rates, date: hardcoded.date, loading: false, error: false };
    }
    if (!baseCode || needed.length === 0) {
      return { rates: {}, date: null, loading: false, error: false };
    }
    const hit = readCache(baseCode);
    if (hit) return { rates: hit.rates, date: hit.date, loading: false, error: false };
    return { rates: null, date: null, loading: true, error: false };
  });

  useEffect(() => {
    if (hardcoded) {
      setState({ rates: hardcoded.rates, date: hardcoded.date, loading: false, error: false });
      return;
    }
    if (!baseCode || needed.length === 0) {
      setState({ rates: {}, date: null, loading: false, error: false });
      return;
    }

    const hit = readCache(baseCode);
    if (hit) {
      setState({ rates: hit.rates, date: hit.date, loading: false, error: false });
      return;
    }

    let cancelled = false;
    setState({ rates: null, date: null, loading: true, error: false });
    loadRates(baseCode)
      .then((result) => {
        if (!cancelled) setState({ rates: result.rates, date: result.date, loading: false, error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ rates: null, date: null, loading: false, error: true });
      });

    return () => {
      cancelled = true;
    };
    // neededKey gates the "nothing to convert" short-circuit; the endpoint
    // returns every code, so the fetch itself is per-base.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseCode, neededKey, hardcoded]);

  return state;
}
