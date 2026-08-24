/**
 * Conversion math. open.er-api's `rates[X]` is "units of X per one unit of
 * base", so converting X → base divides. Tests hardcode the table; the hook
 * and the day cache are not exercised here.
 *
 * A missing rate must return null, never 1.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertMinor, convertBalances, friendDashboardColumn, needsConversion } from "./exchangeRates.ts";

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

test("needsConversion is true only when some amount is not already the preferred code", () => {
  assert.equal(needsConversion([{ currencyCode: "USD" }], "USD"), false);
  assert.equal(needsConversion([{ currencyCode: "usd" }], "USD"), false);
  assert.equal(needsConversion([{ currencyCode: "JPY" }], "USD"), true);
  assert.equal(
    needsConversion(
      [
        { currencyCode: "USD" },
        { currencyCode: "JPY" },
      ],
      "USD",
    ),
    true,
  );
});

test("friendDashboardColumn puts a mixed friend on the side of the converted net", () => {
  const mixed = [
    { currencyCode: "USD", amountMinor: -48800 },
    { currencyCode: "JPY", amountMinor: 159010 },
  ];
  // 159,010 JPY = 1,000.00 USD, minus 488.00 USD owed → net +512.00 USD.
  const rates = { JPY: 159.01 };
  assert.equal(friendDashboardColumn(mixed, "USD", rates, decimalsFor), "owed");
  assert.equal(
    friendDashboardColumn(
      [
        { currencyCode: "USD", amountMinor: -200000 },
        { currencyCode: "JPY", amountMinor: 15901 },
      ],
      "USD",
      rates,
      decimalsFor,
    ),
    "owe",
  );
});

test("friendDashboardColumn keeps mixed friends in both columns without rates", () => {
  const mixed = [
    { currencyCode: "USD", amountMinor: -48800 },
    { currencyCode: "JPY", amountMinor: 159010 },
  ];
  assert.equal(friendDashboardColumn(mixed, "USD", null, decimalsFor), "both");
  assert.equal(
    friendDashboardColumn([{ currencyCode: "USD", amountMinor: -500 }], "USD", null, decimalsFor),
    "owe",
  );
  assert.equal(
    friendDashboardColumn([], "USD", null, decimalsFor),
    "none",
  );
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
