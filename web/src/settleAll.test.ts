/**
 * `applyBalanceDelta` is the one piece of arithmetic this module owns; the
 * settle-all plan itself is src/domain/settle.ts's `planSettleAll`, tested
 * there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBalanceDelta, cancellingCurrencies, settleAllHint } from "./settleAll.ts";

test("adds to an existing currency", () => {
  assert.deepEqual(
    applyBalanceDelta([{ currencyCode: "JPY", amountMinor: 1000 }], "JPY", 500),
    [{ currencyCode: "JPY", amountMinor: 1500 }],
  );
});

test("introduces a currency that was not present", () => {
  assert.deepEqual(
    applyBalanceDelta([{ currencyCode: "USD", amountMinor: 100 }], "JPY", 500),
    [{ currencyCode: "USD", amountMinor: 100 }, { currencyCode: "JPY", amountMinor: 500 }],
  );
});

test("drops a currency that lands on zero", () => {
  assert.deepEqual(
    applyBalanceDelta([{ currencyCode: "JPY", amountMinor: 500 }], "JPY", -500),
    [],
  );
});

test("the hint names the currency, not 'overall'", () => {
  assert.equal(
    settleAllHint([{ currencyCode: "JPY" }, { currencyCode: "JPY" }]),
    "2 JPY balances below cancel each other out, so nothing is owed in JPY overall - but each still reads as unsettled on its own.",
  );
});

test("a single cancelling balance reads in the singular", () => {
  assert.equal(
    settleAllHint([{ currencyCode: "USD" }]),
    "One USD balance below cancels out elsewhere, so nothing is owed in USD overall - but it still reads as unsettled on its own.",
  );
});

test("several currencies are listed, and the count stays currency-free", () => {
  assert.equal(
    settleAllHint([
      { currencyCode: "JPY" },
      { currencyCode: "JPY" },
      { currencyCode: "EUR" },
      { currencyCode: "EUR" },
    ]),
    "4 balances below cancel each other out, so nothing is owed in JPY or EUR overall - but each still reads as unsettled on its own.",
  );
});

test("currencies are deduplicated in plan order", () => {
  assert.deepEqual(
    cancellingCurrencies([{ currencyCode: "JPY" }, { currencyCode: "EUR" }, { currencyCode: "JPY" }]),
    ["JPY", "EUR"],
  );
});
