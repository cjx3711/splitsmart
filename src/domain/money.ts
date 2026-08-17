/**
 * Money handling.
 *
 * Every amount in this codebase is an integer number of MINOR UNITS (cents,
 * pence, yen). Floating point never touches a stored amount. The only places
 * that convert are the edges: parsing user/API input, and formatting output.
 *
 * A minor-unit integer is meaningless without its currency's decimal_places:
 * 1000 is 10.00 USD but 1000 JPY. Always carry the currency alongside.
 */

/** Fallback used when a currency isn't in the currencies table. */
const DEFAULT_DECIMAL_PLACES = 2;

export class MoneyError extends Error {}

/**
 * Parses a decimal string like "25.00" into minor units.
 *
 * Deliberately string-based rather than `Math.round(parseFloat(s) * 100)`,
 * which is wrong for values such as "8.115" that have no exact binary
 * representation. Splitwise sends amounts as decimal strings, so this is the
 * function the compat layer uses on every inbound expense.
 */
export function parseAmount(input: string | number, decimalPlaces = DEFAULT_DECIMAL_PLACES): number {
  const raw = typeof input === "number" ? input.toFixed(decimalPlaces) : input.trim();

  if (!/^-?\d*(\.\d*)?$/.test(raw) || raw === "" || raw === "." || raw === "-") {
    throw new MoneyError(`Not a valid amount: ${JSON.stringify(input)}`);
  }

  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  // More precision than the currency supports is a caller bug, not something to
  // silently round away; rounding here is how money quietly goes missing.
  if (fraction.length > decimalPlaces) {
    throw new MoneyError(
      `${raw} has more than ${decimalPlaces} decimal place(s) for this currency`,
    );
  }

  const padded = fraction.padEnd(decimalPlaces, "0");
  const minor = Number(whole) * 10 ** decimalPlaces + Number(padded || "0");

  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError(`Amount out of safe integer range: ${raw}`);
  }
  return negative ? -minor : minor;
}

/**
 * Formats minor units back to a plain decimal string ("2500" -> "25.00").
 *
 * No currency symbol, no thousands separators: this is the wire format the
 * Splitwise-compatible API returns, and it must round-trip through parseAmount
 * exactly. Display formatting belongs in the frontend.
 */
export function formatAmount(minor: number, decimalPlaces = DEFAULT_DECIMAL_PLACES): string {
  if (!Number.isInteger(minor)) {
    throw new MoneyError(`Refusing to format non-integer minor units: ${minor}`);
  }
  const negative = minor < 0;
  const abs = Math.abs(minor);

  if (decimalPlaces === 0) return `${negative ? "-" : ""}${abs}`;

  const divisor = 10 ** decimalPlaces;
  const whole = Math.floor(abs / divisor);
  const fraction = String(abs % divisor).padStart(decimalPlaces, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * Splits `total` into `count` parts that sum EXACTLY back to `total`.
 *
 * The remainder is distributed one minor unit at a time to the first N parts.
 * Callers pass participants in a stable order (user_id ascending) so the same
 * expense always produces the same allocation; otherwise re-saving an expense
 * would shuffle whose cent it is and balances would drift.
 *
 * splitEvenly(1000, 3) -> [334, 333, 333]
 */
export function splitEvenly(total: number, count: number): number[] {
  if (count <= 0) throw new MoneyError("Cannot split among zero participants");
  if (!Number.isInteger(total)) throw new MoneyError("total must be minor units");

  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(total);
  const base = Math.floor(abs / count);
  const remainder = abs % count;

  return Array.from({ length: count }, (_, i) =>
    sign * (base + (i < remainder ? 1 : 0)),
  );
}

/**
 * Distributes `total` in proportion to `weights`, guaranteeing the parts sum
 * exactly to `total`.
 *
 * Uses largest-remainder: floor every share, then hand the leftover units to
 * whoever lost the most to rounding. Ties break by index so the result is
 * deterministic. Used for percent and shares splits.
 */
export function splitByWeights(total: number, weights: number[]): number[] {
  if (weights.length === 0) throw new MoneyError("Cannot split among zero participants");
  if (weights.some((w) => w < 0)) throw new MoneyError("Weights must be non-negative");

  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight <= 0) throw new MoneyError("Weights must sum to more than zero");

  const exact = weights.map((w) => (total * w) / totalWeight);
  const floored = exact.map((v) => Math.floor(v));
  let remainder = total - floored.reduce((a, b) => a + b, 0);

  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const result = [...floored];
  for (let k = 0; remainder > 0; k++, remainder--) {
    const target = order[k % order.length];
    if (target) result[target.i] = (result[target.i] ?? 0) + 1;
  }
  return result;
}
