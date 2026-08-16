import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeSplit, deriveRepayments, simpleEqualSplit, SplitError } from "./split.ts";
import { parseAmount, formatAmount, splitEvenly, splitByWeights, MoneyError } from "./money.ts";

describe("money", () => {
  test("parses decimal strings without float error", () => {
    assert.equal(parseAmount("25.00"), 2500);
    assert.equal(parseAmount("0.01"), 1);
    assert.equal(parseAmount("8.11"), 811);
    assert.equal(parseAmount("100"), 10000);
    assert.equal(parseAmount("-5.50"), -550);
  });

  test("respects currency decimal places", () => {
    assert.equal(parseAmount("1000", 0), 1000); // JPY
    assert.equal(parseAmount("1.234", 3), 1234); // KWD
    assert.equal(formatAmount(1000, 0), "1000");
    assert.equal(formatAmount(1234, 3), "1.234");
  });

  test("rejects excess precision rather than silently rounding", () => {
    assert.throws(() => parseAmount("1.234"), MoneyError);
    assert.throws(() => parseAmount("10.5", 0), MoneyError);
  });

  test("rejects junk input", () => {
    for (const bad of ["", "abc", "1.2.3", "$5", "1,000"]) {
      assert.throws(() => parseAmount(bad), MoneyError, `should reject ${bad}`);
    }
  });

  test("round-trips through format and parse", () => {
    for (const minor of [0, 1, 99, 100, 12345, 999999]) {
      assert.equal(parseAmount(formatAmount(minor)), minor);
    }
  });

  test("splitEvenly always sums to the total", () => {
    for (let total = 0; total < 200; total++) {
      for (let n = 1; n <= 7; n++) {
        const parts = splitEvenly(total, n);
        assert.equal(parts.length, n);
        assert.equal(parts.reduce((a, b) => a + b, 0), total, `${total}/${n}`);
      }
    }
  });

  test("splitEvenly gives the odd cent to the earliest participants", () => {
    assert.deepEqual(splitEvenly(1000, 3), [334, 333, 333]);
    assert.deepEqual(splitEvenly(1001, 3), [334, 334, 333]);
  });

  test("splitByWeights sums to the total", () => {
    assert.deepEqual(splitByWeights(1000, [1, 1, 1]), [334, 333, 333]);
    assert.deepEqual(splitByWeights(1000, [50, 50]), [500, 500]);
    assert.deepEqual(splitByWeights(100, [1, 2]), [33, 67]);
    assert.equal(
      splitByWeights(9999, [7, 11, 13]).reduce((a, b) => a + b, 0),
      9999,
    );
  });
});

describe("computeSplit", () => {
  test("equal split of an indivisible amount still balances", () => {
    const result = computeSplit(1000, "equal", [
      { userId: 1, paidMinor: 1000 },
      { userId: 2, paidMinor: 0 },
      { userId: 3, paidMinor: 0 },
    ]);
    assert.deepEqual(
      result.map((r) => r.owedMinor),
      [334, 333, 333],
    );
    assert.equal(sum(result.map((r) => r.owedMinor)), 1000);
    assert.equal(sum(result.map((r) => r.paidMinor)), 1000);
  });

  test("is stable regardless of input order", () => {
    const a = computeSplit(1000, "equal", [
      { userId: 3, paidMinor: 0 },
      { userId: 1, paidMinor: 1000 },
      { userId: 2, paidMinor: 0 },
    ]);
    const b = computeSplit(1000, "equal", [
      { userId: 1, paidMinor: 1000 },
      { userId: 2, paidMinor: 0 },
      { userId: 3, paidMinor: 0 },
    ]);
    assert.deepEqual(a, b);
  });

  test("supports multiple payers", () => {
    const result = computeSplit(3000, "equal", [
      { userId: 1, paidMinor: 2000 },
      { userId: 2, paidMinor: 1000 },
      { userId: 3, paidMinor: 0 },
    ]);
    assert.equal(sum(result.map((r) => r.paidMinor)), 3000);
    assert.deepEqual(
      result.map((r) => r.owedMinor),
      [1000, 1000, 1000],
    );
  });

  test("exact split must add up to the total", () => {
    const ok = computeSplit(1000, "exact", [
      { userId: 1, paidMinor: 1000, input: 600 },
      { userId: 2, paidMinor: 0, input: 400 },
    ]);
    assert.deepEqual(ok.map((r) => r.owedMinor), [600, 400]);

    assert.throws(
      () =>
        computeSplit(1000, "exact", [
          { userId: 1, paidMinor: 1000, input: 600 },
          { userId: 2, paidMinor: 0, input: 300 },
        ]),
      SplitError,
    );
  });

  test("percent split handles thirds", () => {
    const result = computeSplit(1000, "percent", [
      { userId: 1, paidMinor: 1000, input: 33.33 },
      { userId: 2, paidMinor: 0, input: 33.33 },
      { userId: 3, paidMinor: 0, input: 33.34 },
    ]);
    assert.equal(sum(result.map((r) => r.owedMinor)), 1000);
  });

  test("percent split rejects totals that aren't 100", () => {
    assert.throws(
      () =>
        computeSplit(1000, "percent", [
          { userId: 1, paidMinor: 1000, input: 50 },
          { userId: 2, paidMinor: 0, input: 30 },
        ]),
      SplitError,
    );
  });

  test("shares split divides by weight", () => {
    const result = computeSplit(3000, "shares", [
      { userId: 1, paidMinor: 3000, input: 2 },
      { userId: 2, paidMinor: 0, input: 1 },
    ]);
    assert.deepEqual(result.map((r) => r.owedMinor), [2000, 1000]);
  });

  test("adjustment applies fixed amounts then splits the rest", () => {
    // 30.00 total, user 2 had a 6.00 dessert nobody else shares.
    const result = computeSplit(3000, "adjustment", [
      { userId: 1, paidMinor: 3000, input: 0 },
      { userId: 2, paidMinor: 0, input: 600 },
      { userId: 3, paidMinor: 0, input: 0 },
    ]);
    assert.deepEqual(result.map((r) => r.owedMinor), [800, 1400, 800]);
    assert.equal(sum(result.map((r) => r.owedMinor)), 3000);
  });

  test("rejects payments that don't match the total", () => {
    assert.throws(
      () =>
        computeSplit(1000, "equal", [
          { userId: 1, paidMinor: 900 },
          { userId: 2, paidMinor: 0 },
        ]),
      SplitError,
    );
  });

  test("rejects duplicate participants", () => {
    assert.throws(
      () =>
        computeSplit(1000, "equal", [
          { userId: 1, paidMinor: 1000 },
          { userId: 1, paidMinor: 0 },
        ]),
      SplitError,
    );
  });

  test("invariant holds across a wide range of totals and group sizes", () => {
    for (let total = 0; total <= 500; total += 7) {
      for (let n = 1; n <= 6; n++) {
        const participants = Array.from({ length: n }, (_, i) => ({
          userId: i + 1,
          paidMinor: i === 0 ? total : 0,
        }));
        const result = computeSplit(total, "equal", participants);
        assert.equal(sum(result.map((r) => r.owedMinor)), total);
        assert.equal(sum(result.map((r) => r.paidMinor)), total);
      }
    }
  });
});

describe("deriveRepayments", () => {
  test("single payer produces one debt per other participant", () => {
    const shares = simpleEqualSplit(3000, 1, [1, 2, 3]);
    const repayments = deriveRepayments(shares);
    assert.equal(repayments.length, 2);
    assert.ok(repayments.every((r) => r.toUserId === 1));
    assert.equal(sum(repayments.map((r) => r.amountMinor)), 2000);
  });

  test("a fully settled expense produces no repayments", () => {
    const shares = computeSplit(1000, "exact", [
      { userId: 1, paidMinor: 600, input: 600 },
      { userId: 2, paidMinor: 400, input: 400 },
    ]);
    assert.deepEqual(deriveRepayments(shares), []);
  });

  test("repayments always net out to zero", () => {
    const shares = computeSplit(6000, "equal", [
      { userId: 1, paidMinor: 4000 },
      { userId: 2, paidMinor: 2000 },
      { userId: 3, paidMinor: 0 },
      { userId: 4, paidMinor: 0 },
    ]);
    const repayments = deriveRepayments(shares);

    const net = new Map<number, number>();
    for (const r of repayments) {
      net.set(r.fromUserId, (net.get(r.fromUserId) ?? 0) - r.amountMinor);
      net.set(r.toUserId, (net.get(r.toUserId) ?? 0) + r.amountMinor);
    }
    for (const s of shares) {
      assert.equal(net.get(s.userId) ?? 0, s.paidMinor - s.owedMinor);
    }
  });

  test("is deterministic", () => {
    const shares = computeSplit(1000, "equal", [
      { userId: 1, paidMinor: 500 },
      { userId: 2, paidMinor: 500 },
      { userId: 3, paidMinor: 0 },
    ]);
    assert.deepEqual(deriveRepayments(shares), deriveRepayments(shares));
  });
});

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
