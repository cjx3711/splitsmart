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

export interface RoundedAmount {
  minor: number;
  /**
   * Signed decimal string of the correction rounding applied, e.g. `"-0.02"`
   * when `"197529.02"` JPY became 197529, or `"+0.34"` when `"6845.66"` JPY
   * became 6846. Null when the input already fit the currency exactly.
   */
  adjustment: string | null;
}

/**
 * Parses a decimal string into minor units, ROUNDING the digits the currency
 * cannot hold rather than discarding them. Trailing zeros are not extra
 * precision (`"3400.0"` JPY is 3400); `"197529.02"` JPY becomes 197529 with
 * `adjustment: "-0.02"` and `"6845.66"` JPY becomes 6846 with `"+0.34"`.
 *
 * Rounding rather than truncating is deliberate and it is about drift, not
 * about any single bill. Splitwise stores JPY with cents, so a long shared
 * history hits this on most rows. Truncation is biased - every correction is
 * negative - so the error accumulates in one direction and a friend total ends
 * up tens of yen off. Rounding half away from zero centres the error at zero,
 * so the corrections cancel instead of compounding and the leftover stays
 * inside what `POST /import/rounding` is allowed to settle.
 *
 * Import is the only caller that wants this. Everywhere else uses `parseAmount`,
 * which refuses the extra digits so a UI typo cannot silently move money.
 */
export function parseAmountRounded(
  input: string | number,
  decimalPlaces = DEFAULT_DECIMAL_PLACES,
): RoundedAmount {
  const raw = typeof input === "number" ? String(input) : input.trim();

  if (!/^-?\d*(\.\d*)?$/.test(raw) || raw === "" || raw === "." || raw === "-") {
    throw new MoneyError(`Not a valid amount: ${JSON.stringify(input)}`);
  }

  const negative = raw.startsWith("-");
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole = "0", fraction = ""] = unsigned.split(".");

  const kept = fraction.slice(0, decimalPlaces);
  const extra = fraction.slice(decimalPlaces).replace(/0+$/, "");

  const padded = kept.padEnd(decimalPlaces, "0");
  const floored = Number(whole || "0") * 10 ** decimalPlaces + Number(padded || "0");

  // Half away from zero, decided on the digit string so no float is involved:
  // "5" or higher in the first discarded place means the next minor unit is
  // closer. The carry takes care of itself because `minor` is a plain integer
  // ("9.99" at 1dp is 99 + 1 = 100, i.e. "10.0").
  const roundsUp = extra.length > 0 && extra.charCodeAt(0) >= 53; // '5'
  const minor = floored + (roundsUp ? 1 : 0);

  if (!Number.isSafeInteger(minor)) {
    throw new MoneyError(`Amount out of safe integer range: ${raw}`);
  }

  return {
    // `-0` would round-trip through SQLite as a float; normalise it away.
    minor: negative && minor !== 0 ? -minor : minor,
    adjustment:
      extra.length === 0
        ? null
        : roundingAdjustment(negative, extra, decimalPlaces),
  };
}

/**
 * The signed decimal string describing what rounding moved.
 *
 * Rounding down discards `0.00<extra>`; rounding up adds the complement, one
 * unit in the last place the currency keeps minus what was discarded. Computed
 * on digit strings rather than floats so `"0.1"` + `"0.2"` cannot show up here.
 */
function roundingAdjustment(
  negative: boolean,
  extra: string,
  decimalPlaces: number,
): string {
  const roundsUp = extra.charCodeAt(0) >= 53;
  const magnitude = roundsUp
    ? subtractFromOneUlp(extra)
    : `0.${"0".repeat(decimalPlaces)}${extra}`;
  // Rounding a negative amount up in magnitude moves it further below zero.
  const movesUp = roundsUp !== negative;
  return `${movesUp ? "+" : "-"}${roundsUp ? shiftRight(magnitude, decimalPlaces) : magnitude}`;
}

/** `"66"` -> `"0.34"`: one unit in the first discarded place, minus `extra`. */
function subtractFromOneUlp(extra: string): string {
  const borrowed = String(10 ** extra.length - Number(extra)).padStart(extra.length, "0");
  return `0.${borrowed}`;
}

/** Moves a `0.x` string `places` digits to the right of the decimal point. */
function shiftRight(value: string, places: number): string {
  if (places === 0) return value;
  const digits = value.slice(2);
  return `0.${"0".repeat(places)}${digits}`;
}

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
  const parsed = parseAmountRounded(raw, decimalPlaces);
  if (parsed.adjustment !== null) {
    throw new MoneyError(
      `${raw} has more than ${decimalPlaces} decimal place(s) for this currency`,
    );
  }
  return parsed.minor;
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
