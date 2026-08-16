import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CURRENCIES, NON_STANDARD_DECIMALS } from "./currencies.ts";
import { parseAmount, formatAmount } from "../domain/money.ts";

describe("currency table", () => {
  test("covers the major world currencies", () => {
    const codes = new Set(CURRENCIES.map((c) => c.code));
    for (const code of [
      "USD", "EUR", "GBP", "JPY", "CNY", "SGD", "AUD", "CAD", "CHF",
      "INR", "MYR", "THB", "IDR", "VND", "KRW", "TWD", "HKD", "PHP",
      "BRL", "MXN", "ZAR", "AED", "SAR", "TRY", "RUB", "PLN", "SEK",
    ]) {
      assert.ok(codes.has(code), `missing ${code}`);
    }
  });

  test("is a substantial list, not a token sample", () => {
    // Splitwise supports roughly 150. A short list is a bug: currency_code is a
    // foreign key, so a missing entry rejects the expense outright.
    assert.ok(CURRENCIES.length >= 150, `only ${CURRENCIES.length} currencies`);
  });

  test("has no duplicate codes", () => {
    const codes = CURRENCIES.map((c) => c.code);
    assert.equal(new Set(codes).size, codes.length);
  });

  test("codes are uppercase ISO 4217 triples", () => {
    for (const c of CURRENCIES) {
      assert.match(c.code, /^[A-Z]{3}$/, `bad code: ${c.code}`);
      assert.ok(c.name.length > 0, `${c.code} has no name`);
    }
  });

  test("is sorted by code", () => {
    const sorted = [...CURRENCIES].sort((a, b) => a.code.localeCompare(b.code));
    assert.deepEqual(CURRENCIES.map((c) => c.code), sorted.map((c) => c.code));
  });
});

describe("decimal places", () => {
  // These are the values that silently multiply or divide money by 100 if
  // wrong. Pinned explicitly rather than spot-checked.
  const ZERO_DECIMAL = [
    "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW",
    "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
  ];
  const THREE_DECIMAL = ["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"];

  const byCode = new Map(CURRENCIES.map((c) => [c.code, c]));

  test("zero-decimal currencies are exactly the expected set", () => {
    for (const code of ZERO_DECIMAL) {
      assert.equal(byCode.get(code)?.decimals, 0, `${code} should be 0`);
    }
    const actual = CURRENCIES.filter((c) => c.decimals === 0).map((c) => c.code).sort();
    assert.deepEqual(actual, [...ZERO_DECIMAL].sort());
  });

  test("three-decimal currencies are exactly the expected set", () => {
    for (const code of THREE_DECIMAL) {
      assert.equal(byCode.get(code)?.decimals, 3, `${code} should be 3`);
    }
    const actual = CURRENCIES.filter((c) => c.decimals === 3).map((c) => c.code).sort();
    assert.deepEqual(actual, [...THREE_DECIMAL].sort());
  });

  test("every exponent is within the schema's CHECK range", () => {
    for (const c of CURRENCIES) {
      assert.ok(
        c.decimals >= 0 && c.decimals <= 4,
        `${c.code} has out-of-range decimals: ${c.decimals}`,
      );
    }
  });

  test("the overwhelming majority are 2", () => {
    const two = CURRENCIES.filter((c) => c.decimals === 2).length;
    assert.ok(two / CURRENCIES.length > 0.8);
  });

  test("amounts round-trip at every currency's precision", () => {
    for (const currency of CURRENCIES) {
      const minor = 123456;
      const formatted = formatAmount(minor, currency.decimals);
      assert.equal(
        parseAmount(formatted, currency.decimals),
        minor,
        `${currency.code} failed to round-trip`,
      );
    }
  });

  test("1000 minor units renders correctly per currency", () => {
    assert.equal(formatAmount(1000, byCode.get("USD")!.decimals), "10.00");
    assert.equal(formatAmount(1000, byCode.get("JPY")!.decimals), "1000");
    assert.equal(formatAmount(1000, byCode.get("KWD")!.decimals), "1.000");
  });

  test("non-standard currencies are surfaced for test coverage", () => {
    assert.equal(NON_STANDARD_DECIMALS.length, ZERO_DECIMAL.length + THREE_DECIMAL.length + 2);
  });
});
