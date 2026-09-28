import assert from "node:assert/strict";
import { test } from "node:test";
import { localToday, shiftExpenseDate } from "./expenseDate.ts";

test("day buttons cross month, year and leap-day boundaries", () => {
  for (const [before, after] of [
    ["2026-09-30", "2026-10-01"],
    ["2026-12-31", "2027-01-01"],
    ["2024-02-28", "2024-02-29"],
    ["2024-02-29", "2024-03-01"],
    ["2026-02-28", "2026-03-01"],
    ["2026-03-08", "2026-03-09"],
    ["2026-11-01", "2026-11-02"],
  ]) {
    assert.equal(shiftExpenseDate(before!, 1), after);
    assert.equal(shiftExpenseDate(after!, -1), before);
  }
});

test("today follows the user's calendar on either side of UTC midnight", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo";
    assert.equal(localToday(new Date("2026-09-28T16:00:00Z")), "2026-09-29");
    process.env.TZ = "America/Los_Angeles";
    assert.equal(localToday(new Date("2026-09-29T02:00:00Z")), "2026-09-28");
    assert.equal(shiftExpenseDate("2026-03-08", 1), "2026-03-09");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("date stepping stays within the date field's supported years", () => {
  assert.equal(shiftExpenseDate("0001-01-01", -1), "0001-01-01");
  assert.equal(shiftExpenseDate("9999-12-31", 1), "9999-12-31");
  assert.equal(shiftExpenseDate("", 1), shiftExpenseDate(localToday(), 1));
});
