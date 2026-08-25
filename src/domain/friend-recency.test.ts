import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compareByLastExpense, lastSharedExpenseIdByUser } from "./friend-recency.ts";
import { IMPORT_ROUNDING_DETAILS } from "./metadata.ts";
import { ulid } from "./ulid.ts";

const t0 = Date.parse("2020-01-15T12:00:00.000Z");
const older = ulid(t0);
const newer = ulid(t0 + 1);
const newest = ulid(t0 + 2);

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

  test("an import rounding settle-up does not count as a shared expense", () => {
    const last = lastSharedExpenseIdByUser(
      [
        {
          id: older,
          shares: [{ userId: "me" }, { userId: "a" }],
        },
        {
          id: newest,
          details: IMPORT_ROUNDING_DETAILS,
          shares: [{ userId: "me" }, { userId: "a" }],
        },
      ],
      "me",
    );
    assert.equal(last.get("a"), older);
  });

  test("an import rounding settle-up flagged on the sync document is skipped too", () => {
    const last = lastSharedExpenseIdByUser(
      [
        {
          id: older,
          shares: [{ userId: "me" }, { userId: "a" }],
        },
        {
          id: newest,
          importRounding: true,
          shares: [{ userId: "me" }, { userId: "a" }],
        },
      ],
      "me",
    );
    assert.equal(last.get("a"), older);
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

  test("same-millisecond last expenses break by name, not the random suffix", () => {
    const sameMsA = newer.slice(0, 10) + "AAAAAAAAAAAAAAAZ";
    const sameMsB = newer.slice(0, 10) + "0000000000000000";
    const last = new Map([
      ["z", sameMsA],
      ["a", sameMsB],
    ]);
    // Zzz would sort first if the random ULID suffix counted as recency.
    assert.ok(compareByLastExpense("a", "z", last, "Ann", "Zzz") < 0);
  });

  test("equal recency and name break by id", () => {
    const last = new Map([
      ["b", newer],
      ["a", newer],
    ]);
    assert.ok(compareByLastExpense("a", "b", last, "Ann", "Ann") < 0);
    assert.ok(compareByLastExpense("b", "a", last, "Ann", "Ann") > 0);
  });
});
