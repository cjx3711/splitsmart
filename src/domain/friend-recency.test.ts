import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compareByLastExpense, lastSharedExpenseIdByUser } from "./friend-recency.ts";

const older = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const newer = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
const newest = "01ARZ3NDEKTSV4RRFFQ69G5FAC";

describe("lastSharedExpenseIdByUser", () => {
  test("keeps the newest bill both people are on", () => {
    const last = lastSharedExpenseIdByUser(
      [
        {
          id: older,
          shares: [{ userId: "me" }, { userId: "a" }],
        },
        {
          id: newer,
          shares: [{ userId: "me" }, { userId: "a" }],
        },
      ],
      "me",
    );
    assert.equal(last.get("a"), newer);
  });

  test("a three-way bill counts for every other participant", () => {
    const last = lastSharedExpenseIdByUser(
      [
        {
          id: newer,
          shares: [{ userId: "me" }, { userId: "a" }, { userId: "b" }],
        },
      ],
      "me",
    );
    assert.equal(last.get("a"), newer);
    assert.equal(last.get("b"), newer);
    assert.equal(last.has("me"), false);
  });

  test("ignores bills the caller is not on", () => {
    const last = lastSharedExpenseIdByUser(
      [
        {
          id: newest,
          shares: [{ userId: "a" }, { userId: "b" }],
        },
      ],
      "me",
    );
    assert.equal(last.size, 0);
  });
});

describe("compareByLastExpense", () => {
  test("the more recent shared expense sorts first", () => {
    const last = new Map([
      ["a", older],
      ["b", newer],
    ]);
    assert.ok(compareByLastExpense("b", "a", last, "B", "A") < 0);
    assert.ok(compareByLastExpense("a", "b", last, "A", "B") > 0);
  });

  test("no shared expense sorts after someone with one", () => {
    const last = new Map([["a", older]]);
    assert.ok(compareByLastExpense("a", "z", last, "A", "Z") < 0);
    assert.ok(compareByLastExpense("z", "a", last, "Z", "A") > 0);
  });

  test("ties break by name", () => {
    const last = new Map([
      ["a", newer],
      ["b", newer],
    ]);
    assert.ok(compareByLastExpense("a", "b", last, "Ann", "Bob") < 0);
  });
});
