/**
 * The subtraction the dashboard and the friend page do in the browser.
 *
 * The case that matters is the last one: an excluded bucket must not be able to
 * change a counted figure, in either direction, even when the two hold opposite
 * amounts in the same currency.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  countedBalances,
  excludedBuckets,
  excludedGroupNames,
  listNames,
  type CountableBucket,
} from "./excludedTotals.ts";

const bucket = (
  groupId: string | null,
  excluded: boolean,
  balances: Array<[string, number]>,
  groupName?: string,
): CountableBucket => ({
  groupId,
  groupName: groupName ?? (groupId === null ? null : groupId),
  excluded,
  balances: balances.map(([currencyCode, amountMinor]) => ({ currencyCode, amountMinor })),
});

describe("countedBalances", () => {
  test("adds the buckets that count and drops the ones that do not", () => {
    assert.deepEqual(
      countedBalances([
        bucket("trip", false, [["USD", 1200]]),
        bucket("amex", true, [["USD", 50000]]),
        bucket(null, false, [["USD", 300]]),
      ]),
      [{ currencyCode: "USD", amountMinor: 1500 }],
    );
  });

  test("nothing excluded is the full sum", () => {
    const breakdown = [
      bucket("trip", false, [["JPY", 3400]]),
      bucket(null, false, [["USD", -900]]),
    ];
    assert.deepEqual(countedBalances(breakdown), [
      { currencyCode: "JPY", amountMinor: 3400 },
      { currencyCode: "USD", amountMinor: -900 },
    ]);
  });

  test("everything excluded counts as nothing, not as settled-with-a-number", () => {
    assert.deepEqual(countedBalances([bucket("amex", true, [["USD", 50000]])]), []);
  });

  test("currencies stay separate and zero rows are dropped", () => {
    assert.deepEqual(
      countedBalances([
        bucket("a", false, [["USD", 1000], ["JPY", 500]]),
        bucket("b", false, [["USD", -1000]]),
      ]),
      [{ currencyCode: "JPY", amountMinor: 500 }],
    );
  });

  test("an excluded bucket cannot cancel a counted one", () => {
    const counted = countedBalances([
      bucket("trip", false, [["USD", 2500]]),
      bucket("amex", true, [["USD", -2500]]),
    ]);
    assert.deepEqual(counted, [{ currencyCode: "USD", amountMinor: 2500 }]);
  });
});

describe("naming what was left out", () => {
  test("only excluded buckets holding something", () => {
    const names = excludedGroupNames([
      [
        bucket("a", true, [["USD", 100]], "Amex"),
        bucket("b", true, [], "Empty ledger"),
        bucket("c", false, [["USD", 100]], "Kyushu"),
      ],
    ]);
    assert.deepEqual(names, ["Amex"]);
  });

  test("deduplicated across friends and sorted", () => {
    const names = excludedGroupNames([
      [bucket("a", true, [["USD", 100]], "Rent")],
      [bucket("a", true, [["USD", -100]], "Rent"), bucket("b", true, [["JPY", 1]], "Amex")],
    ]);
    assert.deepEqual(names, ["Amex", "Rent"]);
  });

  test("an unnamed group still gets said out loud", () => {
    assert.deepEqual(excludedGroupNames([[bucket("a", true, [["USD", 1]], "  ")]]), [
      "Unnamed group",
    ]);
  });

  test("excludedBuckets skips the settled ones", () => {
    const breakdown = [
      bucket("a", true, [["USD", 100]]),
      bucket("b", true, []),
      bucket("c", false, [["USD", 100]]),
    ];
    assert.deepEqual(
      excludedBuckets(breakdown).map((b) => b.groupId),
      ["a"],
    );
  });
});

describe("listNames", () => {
  test("reads as a sentence at every length", () => {
    assert.equal(listNames([]), "");
    assert.equal(listNames(["Amex"]), "Amex");
    assert.equal(listNames(["Amex", "Rent"]), "Amex and Rent");
    assert.equal(listNames(["Amex", "Rent", "Tabs"]), "Amex, Rent and Tabs");
  });
});
