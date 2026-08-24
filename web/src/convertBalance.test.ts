/**
 * Conversion writes a pair of payments per source currency. The tests pin the
 * pairing (who pays whom) and the refusal cases; the rate math itself lives in
 * exchangeRates.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONVERSION_DESCRIPTION,
  formatQuotedRate,
  planBalanceConversion,
  planGroupBalanceConversion,
} from "./convertBalance.ts";

function decimalsFor(code: string): number | null {
  if (code === "JPY") return 0;
  if (code === "USD" || code === "TWD") return 2;
  return null;
}

function formatAmount(minor: number, code: string): string | null {
  const decimals = decimalsFor(code);
  if (decimals === null) return null;
  if (decimals === 0) return String(minor);
  return (minor / 100).toFixed(2);
}

const YOU = "01YOU000000000000000000000";
const THEM = "01THEM00000000000000000000";

// open.er-api-shaped: rates[X] is units of X per one unit of the target.
// 1 JPY = 0.01 USD = 0.20 TWD, so 24.72 USD → 2,472 JPY.
const JPY_RATES = { USD: 0.01, TWD: 0.2 };

function plan(
  balances: Array<{ currencyCode: string; amountMinor: number }>,
  target = "JPY",
  rates: Record<string, number> = JPY_RATES,
) {
  return planBalanceConversion({
    balances,
    targetCode: target,
    rates,
    decimalsFor,
    youId: YOU,
    themId: THEM,
    rateDate: "2026-08-23",
    formatAmount,
  });
}

test("leaves a balance already in the target currency and converts the rest", () => {
  const result = plan([
    { currencyCode: "JPY", amountMinor: 99193 },
    { currencyCode: "USD", amountMinor: 2472 },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.legs.length, 1);
  assert.equal(result.legs[0]?.sourceCode, "USD");
  assert.equal(result.legs[0]?.targetMinor, 2472);
  assert.equal(result.resultMinor, 99193 + 2472);

  assert.deepEqual(
    result.payments.map((p) => ({
      from: p.fromUserId,
      to: p.toUserId,
      amount: p.amountMinor,
      code: p.currencyCode,
    })),
    [
      { from: THEM, to: YOU, amount: 2472, code: "USD" },
      { from: YOU, to: THEM, amount: 2472, code: "JPY" },
    ],
  );
  assert.ok(result.payments.every((p) => p.description === CONVERSION_DESCRIPTION));
  assert.equal(
    result.payments[0]?.comment,
    "Automatic balance conversion: 24.72 USD → 2472 JPY at 1 USD = 100 JPY, using the 2026-08-23 rate.",
  );
  assert.equal(result.payments[0]?.details, result.payments[0]?.comment);
});

test("formatQuotedRate trims a long tail and names both sides", () => {
  assert.equal(formatQuotedRate(2472, "USD", 2472, "JPY", decimalsFor), "1 USD = 100 JPY");
  assert.equal(formatQuotedRate(20000, "TWD", 1000, "JPY", decimalsFor), "1 TWD = 5 JPY");
  assert.equal(formatQuotedRate(100, "USD", 1, "JPY", decimalsFor), "1 USD = 1 JPY");
});

test("a debt you owe reverses both payments", () => {
  const result = plan([{ currencyCode: "USD", amountMinor: -2472 }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.legs[0]?.theyOwe, false);
  assert.equal(result.resultMinor, -2472);
  assert.deepEqual(
    result.payments.map((p) => ({ from: p.fromUserId, to: p.toUserId, code: p.currencyCode })),
    [
      { from: YOU, to: THEM, code: "USD" },
      { from: THEM, to: YOU, code: "JPY" },
    ],
  );
});

test("mixed directions net in the target currency", () => {
  // They owe 10,000 JPY; you owe 24.72 USD → 2,472 JPY.
  const result = plan([
    { currencyCode: "JPY", amountMinor: 10000 },
    { currencyCode: "USD", amountMinor: -2472 },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.resultMinor, 10000 - 2472);
});

test("refuses the whole plan when a rate is missing", () => {
  const result = plan(
    [
      { currencyCode: "USD", amountMinor: 100 },
      { currencyCode: "EUR", amountMinor: 100 },
    ],
    "JPY",
    { USD: 0.006294 },
  );
  assert.deepEqual(result, { ok: false, reason: "missing_rate", currencyCode: "EUR" });
});

test("refuses when a conversion would round to zero", () => {
  // 1 JPY at 0.006294 USD/JPY → 0.01 USD rounded is 0.01; use a tinier rate.
  const result = plan([{ currencyCode: "JPY", amountMinor: 1 }], "USD", { JPY: 100000 });
  assert.deepEqual(result, { ok: false, reason: "rounds_to_zero", currencyCode: "JPY" });
});

test("skips zero balances and needs no payments when everything is already the target", () => {
  const result = plan([
    { currencyCode: "JPY", amountMinor: 500 },
    { currencyCode: "USD", amountMinor: 0 },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.legs, []);
  assert.deepEqual(result.payments, []);
  assert.equal(result.resultMinor, 500);
});

const ALICE = "01ALICE0000000000000000000";
const BOB = "01BOB0000000000000000000000";

function groupPlan(
  transfers: Array<{
    currencyCode: string;
    fromUserId: string;
    toUserId: string;
    amountMinor: number;
  }>,
  target = "JPY",
  rates: Record<string, number> = JPY_RATES,
) {
  return planGroupBalanceConversion({
    transfers,
    targetCode: target,
    rates,
    decimalsFor,
    rateDate: "2026-08-23",
    formatAmount,
  });
}

test("group conversion skips transfers already in the target and converts the rest", () => {
  const result = groupPlan([
    { currencyCode: "JPY", fromUserId: ALICE, toUserId: YOU, amountMinor: 209303 },
    { currencyCode: "USD", fromUserId: ALICE, toUserId: YOU, amountMinor: 2472 },
    { currencyCode: "TWD", fromUserId: YOU, toUserId: ALICE, amountMinor: 20000 },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.legs.length, 2);
  assert.deepEqual(
    result.payments.map((p) => ({
      from: p.fromUserId,
      to: p.toUserId,
      amount: p.amountMinor,
      code: p.currencyCode,
    })),
    [
      { from: ALICE, to: YOU, amount: 2472, code: "USD" },
      { from: YOU, to: ALICE, amount: 2472, code: "JPY" },
      { from: YOU, to: ALICE, amount: 20000, code: "TWD" },
      { from: ALICE, to: YOU, amount: 1000, code: "JPY" },
    ],
  );
});

test("group conversion refuses the whole plan when a rate is missing", () => {
  const result = groupPlan(
    [{ currencyCode: "EUR", fromUserId: ALICE, toUserId: BOB, amountMinor: 100 }],
    "JPY",
    { USD: 0.01 },
  );
  assert.deepEqual(result, { ok: false, reason: "missing_rate", currencyCode: "EUR" });
});

test("group conversion is a no-op when every transfer is already the target", () => {
  const result = groupPlan([
    { currencyCode: "JPY", fromUserId: ALICE, toUserId: YOU, amountMinor: 500 },
  ]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.legs, []);
  assert.deepEqual(result.payments, []);
});
