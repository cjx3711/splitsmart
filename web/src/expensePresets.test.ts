import assert from "node:assert/strict";
import { test } from "node:test";
import { computeSplit } from "../../src/domain/split.ts";
import { expensePreset, type ExpensePreset } from "./expensePresets.ts";

function balances(preset: ExpensePreset, ids: string[], cost: number, payer = "friend") {
  const { split, payment } = expensePreset(preset, ids, "me", payer);
  assert.equal(payment.kind, "single");
  if (payment.kind !== "single") throw new Error("Expected a single payer");
  const result = computeSplit(cost, split.mode, ids.map((userId) => ({
    userId,
    paidMinor: userId === payment.payerId ? cost : 0,
    input: split.mode === "shares" ? Number(split.values[userId]) : undefined,
  })));
  return ids.map((id) => result.find((person) => person.userId === id)!);
}

test("four shortcuts record the correct payer and debt direction", () => {
  for (const [preset, paid, owed] of [
    ["i-owe", [0, 3000], [3000, 0]],
    ["they-owe", [3000, 0], [0, 3000]],
    ["i-paid", [3000, 0], [1500, 1500]],
    ["they-paid", [0, 3000], [1500, 1500]],
  ] as const) {
    const result = balances(preset, ["me", "friend"], 3000);
    assert.deepEqual(result.map((p) => p.paidMinor), paid, preset);
    assert.deepEqual(result.map((p) => p.owedMinor), owed, preset);
  }
});

test("one-sided shortcuts track changing totals and group membership", () => {
  for (const cost of [1, 3100, 3001, 12345678]) {
    const ids = ["me", "friend", "third"];
    const mine = balances("i-owe", ids, cost, "third");
    assert.deepEqual(mine.map((p) => p.owedMinor), [cost, 0, 0]);
    assert.deepEqual(mine.map((p) => p.paidMinor), [0, 0, cost]);
    const theirs = balances("they-owe", ids, cost);
    assert.equal(theirs[0]!.owedMinor, 0);
    assert.equal(theirs[1]!.owedMinor + theirs[2]!.owedMinor, cost);
    assert.ok(Math.abs(theirs[1]!.owedMinor - theirs[2]!.owedMinor) <= 1);
  }
});

test("equal shortcuts preserve every minor unit with either payer", () => {
  for (const preset of ["i-paid", "they-paid"] as const) {
    const result = balances(preset, ["me", "friend", "third"], 3100, "third");
    assert.deepEqual(result.map((p) => p.owedMinor).sort(), [1033, 1033, 1034]);
    assert.equal(result.reduce((sum, p) => sum + p.paidMinor, 0), 3100);
  }
});
