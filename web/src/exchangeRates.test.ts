/**
 * Conversion math. open.er-api's `rates[X]` is "units of X per one unit of
 * base", so converting X → base divides. Tests hardcode the table; the hook
 * and the day cache are not exercised here.
 *
 * A missing rate must return null, never 1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertMinor, convertBalances } from "./exchangeRates.ts";

function decimalsFor(code: string): number | null {
  if (code === "JPY") return 0;
  if (code === "USD") return 2;
  return null;
}

test("same currency is a no-op, even without rates", () => {
  assert.equal(convertMinor(1234, "USD", "USD", {}, decimalsFor), 1234);
});

test("JPY to USD divides by the quoted rate", () => {
  // 1 USD = 159.01 JPY → 15,901 JPY converts to 100.00 USD.
  const rates = { JPY: 159.01 };
  assert.equal(convertMinor(15901, "JPY", "USD", rates, decimalsFor), 10000);
});

test("returns null when the rate is missing rather than assuming 1:1", () => {
  assert.equal(convertMinor(1000, "JPY", "USD", {}, decimalsFor), null);
});

test("returns null when either currency's decimals are unknown", () => {
  assert.equal(convertMinor(1000, "XYZ", "USD", { XYZ: 1 }, decimalsFor), null);
});

test("convertBalances omits the whole total if any currency cannot convert", () => {
  const rates = { JPY: 159.01 };
  assert.equal(
    convertBalances(
      [
        { currencyCode: "USD", amountMinor: 500 },
        { currencyCode: "EUR", amountMinor: 100 },
      ],
      "USD",
      rates,
      decimalsFor,
    ),
    null,
  );
  assert.equal(
    convertBalances(
      [
        { currencyCode: "USD", amountMinor: 500 },
        { currencyCode: "JPY", amountMinor: 15901 },
      ],
      "USD",
      rates,
      decimalsFor,
    ),
    10500,
  );
});
