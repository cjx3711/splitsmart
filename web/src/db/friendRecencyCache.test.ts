import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyTouchedExpenses, cacheFromExpenses } from "./friendRecencyCache.ts";
import { IMPORT_ROUNDING_DETAILS } from "../../../src/domain/metadata.ts";

const older = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const newer = "01ARZ3NDEKTSV4RRFFQ69G5FAB";

const me = "me";
const poh = "poh";

describe("cacheFromExpenses", () => {
  test("records the newest live bill and every counterpart", () => {
    const cache = cacheFromExpenses(
      [
        { id: older, shares: [{ userId: me }, { userId: poh }] },
        { id: newer, shares: [{ userId: me }, { userId: poh }] },
        { id: "01DELETED00000000000000000", shares: [{ userId: me }, { userId: "gone" }], deletedAt: "now" },
      ],
      me,
      [poh, "extra"],
    );
    assert.equal(cache.last[poh], newer);
    assert.deepEqual(cache.related, ["extra", poh]);
    assert.deepEqual(cache.lastByGroup, {});
  });

  test("records the newest live bill per group", () => {
    const cache = cacheFromExpenses(
      [
        { id: older, groupId: "tokyo", shares: [{ userId: me }, { userId: poh }] },
        { id: newer, groupId: "tokyo", shares: [{ userId: me }, { userId: poh }] },
        { id: "01OTHERGROUP00000000000001", groupId: "ski", shares: [{ userId: me }] },
        { id: "01ONEONONE0000000000000001", groupId: null, shares: [{ userId: me }, { userId: poh }] },
      ],
      me,
      [poh],
    );
    assert.equal(cache.lastByGroup.tokyo, newer);
    assert.equal(cache.lastByGroup.ski, "01OTHERGROUP00000000000001");
  });
});

describe("applyTouchedExpenses", () => {
  const seed = cacheFromExpenses(
    [{ id: older, shares: [{ userId: me }, { userId: poh }] }],
    me,
    [poh],
  );

  test("a newer live bill moves that friend up", () => {
    const next = applyTouchedExpenses(
      seed,
      [{ id: newer, shares: [{ userId: me }, { userId: poh }] }],
      me,
    );
    assert.equal(next?.last[poh], newer);
  });

  test("an older bill does not move them down", () => {
    const next = applyTouchedExpenses(
      { ...seed, last: { [poh]: newer } },
      [{ id: older, shares: [{ userId: me }, { userId: poh }] }],
      me,
    );
    assert.equal(next?.last[poh], newer);
  });

  test("a new person is added to related", () => {
    const next = applyTouchedExpenses(
      seed,
      [{ id: newer, shares: [{ userId: me }, { userId: "jj" }] }],
      me,
    );
    assert.ok(next?.related.includes("jj"));
    assert.equal(next?.last.jj, newer);
  });

  test("deleting the stored latest bill asks for a rebuild", () => {
    const next = applyTouchedExpenses(
      seed,
      [{ id: older, shares: [{ userId: me }, { userId: poh }], deletedAt: "now" }],
      me,
    );
    assert.equal(next, null);
  });

  test("deleting some other bill leaves the cache alone", () => {
    const next = applyTouchedExpenses(
      { ...seed, last: { [poh]: newer } },
      [{ id: older, shares: [{ userId: me }, { userId: poh }], deletedAt: "now" }],
      me,
    );
    assert.equal(next?.last[poh], newer);
  });

  test("import-rounding bills do not count as recency", () => {
    const next = applyTouchedExpenses(seed, [
      {
        id: newer,
        shares: [{ userId: me }, { userId: poh }],
        details: IMPORT_ROUNDING_DETAILS,
      },
    ], me);
    assert.equal(next?.last[poh], older);
  });

  test("a newer group bill moves that group up", () => {
    const withGroup = cacheFromExpenses(
      [{ id: older, groupId: "tokyo", shares: [{ userId: me }, { userId: poh }] }],
      me,
      [poh],
    );
    const next = applyTouchedExpenses(
      withGroup,
      [{ id: newer, groupId: "tokyo", shares: [{ userId: me }, { userId: poh }] }],
      me,
    );
    assert.equal(next?.lastByGroup.tokyo, newer);
  });

  test("deleting a group's latest bill asks for a rebuild", () => {
    const withGroup = cacheFromExpenses(
      [{ id: older, groupId: "tokyo", shares: [{ userId: me }, { userId: poh }] }],
      me,
      [poh],
    );
    const next = applyTouchedExpenses(
      withGroup,
      [{ id: older, groupId: "tokyo", shares: [{ userId: me }, { userId: poh }], deletedAt: "now" }],
      me,
    );
    assert.equal(next, null);
  });
});
