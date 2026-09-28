import assert from "node:assert/strict";
import { test } from "node:test";
import { exactSplitHints } from "./exactSplitHints.ts";

test("shows the remaining amount from the screenshot and suggests blank shares", () => {
  const values = { nana: "3742", jay: "3,742" };
  const hint = exactSplitHints(22138, ["you", "ling", "nana", "jay"], values, 0)!;
  assert.equal(hint.remainingMinor, 14654);
  assert.deepEqual([...hint.suggestions], [["ling", 7327], ["you", 7327]]);
  assert.deepEqual(values, { nana: "3742", jay: "3,742" });
  const next = exactSplitHints(22138, ["you", "ling", "nana", "jay"], { ...values, you: "7,327" }, 0)!;
  assert.equal(next.remainingMinor, 7327);
  assert.deepEqual([...next.suggestions], [["ling", 7327]]);
});

test("allocates spare cents or yen deterministically without rounding away money", () => {
  for (const decimals of [0, 2, 3]) {
    const hint = exactSplitHints(1001, ["c", "b", "a"], {}, decimals)!;
    assert.deepEqual([...hint.suggestions], [["a", 334], ["b", 334], ["c", 333]]);
    assert.equal([...hint.suggestions.values()].reduce((sum, amount) => sum + amount, 0), 1001);
  }
  const cents = exactSplitHints(1001, ["a", "b", "c"], { a: "2.00" }, 2)!;
  assert.deepEqual([...cents.suggestions], [["b", 401], ["c", 400]]);
});

test("distinguishes explicit zero from blank and ignores removed participants", () => {
  const hint = exactSplitHints(1000, ["a", "b", "c"], { a: "0", b: " ", removed: "999" }, 2)!;
  assert.equal(hint.emptyCount, 2);
  assert.deepEqual([...hint.suggestions], [["b", 500], ["c", 500]]);
});

test("reports over-allocation and a remainder when every person has an amount", () => {
  const over = exactSplitHints(1000, ["a", "b"], { a: "12.00" }, 2)!;
  assert.equal(over.remainingMinor, -200);
  assert.equal(over.suggestions.size, 0);
  const short = exactSplitHints(1000, ["a", "b"], { a: "3", b: "2" }, 2)!;
  assert.equal(short.remainingMinor, 500);
  assert.equal(short.emptyCount, 0);
  assert.equal(short.suggestions.size, 0);
  const complete = exactSplitHints(1000, ["a", "b"], { a: "10" }, 2)!;
  assert.equal(complete.remainingMinor, 0);
  assert.deepEqual([...complete.suggestions], [["b", 0]]);
});

test("does not suggest amounts while an entry is invalid or the total is missing", () => {
  for (const invalid of ["oops", "1,20", "1.234", "-1", "9007199254740992"]) {
    assert.equal(exactSplitHints(1000, ["a", "b"], { a: invalid }, 2), null);
  }
  assert.equal(exactSplitHints(0, ["a"], {}, 2), null);
  assert.equal(exactSplitHints(1000, [], {}, 2), null);
});
