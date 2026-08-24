import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  isValidUtcDate,
  isoWeekBounds,
  shiftDate,
  utcDate,
  utcHour,
} from "./time.ts";

describe("utcDate", () => {
  test("returns the UTC calendar day, not the local one", () => {
    // 23:30 UTC on the 14th is already the 15th in Tokyo, and still the 14th in UTC.
    assert.equal(utcDate(new Date("2026-08-14T23:30:00Z")), "2026-08-14");
    assert.equal(utcDate(new Date("2026-08-15T00:00:00Z")), "2026-08-15");
  });
});

describe("utcHour", () => {
  test("reads the UTC hour", () => {
    assert.equal(utcHour(new Date("2026-08-14T00:00:00Z")), 0);
    assert.equal(utcHour(new Date("2026-08-14T23:59:59Z")), 23);
  });
});

describe("isValidUtcDate", () => {
  test("accepts real dates", () => {
    assert.equal(isValidUtcDate("2026-08-14"), true);
    assert.equal(isValidUtcDate("2028-02-29"), true);
  });

  test("rejects malformed and impossible dates", () => {
    assert.equal(isValidUtcDate("2026-8-14"), false);
    assert.equal(isValidUtcDate("2026-08-14T00:00:00Z"), false);
    assert.equal(isValidUtcDate(""), false);
    assert.equal(isValidUtcDate("2026-02-31"), false);
    assert.equal(isValidUtcDate("2026-13-01"), false);
    assert.equal(isValidUtcDate("2027-02-29"), false);
  });
});

describe("shiftDate", () => {
  test("shifts within a month", () => {
    assert.equal(shiftDate("2026-08-14", -1), "2026-08-13");
    assert.equal(shiftDate("2026-08-14", 1), "2026-08-15");
    assert.equal(shiftDate("2026-08-14", 0), "2026-08-14");
  });

  test("crosses month boundaries", () => {
    assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
    assert.equal(shiftDate("2026-08-31", 1), "2026-09-01");
    assert.equal(shiftDate("2026-01-31", 1), "2026-02-01");
  });

  test("crosses year boundaries", () => {
    assert.equal(shiftDate("2026-01-01", -1), "2025-12-31");
    assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
  });

  test("handles leap years", () => {
    assert.equal(shiftDate("2028-03-01", -1), "2028-02-29");
    assert.equal(shiftDate("2027-03-01", -1), "2027-02-28");
  });

  test("handles the retention window shift", () => {
    assert.equal(shiftDate("2026-08-14", -6), "2026-08-08");
    assert.equal(shiftDate("2026-01-03", -6), "2025-12-28");
  });

  test("refuses an invalid input rather than inventing a date", () => {
    assert.throws(() => shiftDate("2026-02-31", 1));
  });
});

describe("isoWeekBounds", () => {
  test("bounds a midweek day", () => {
    assert.deepEqual(isoWeekBounds("2026-08-14"), {
      monday: "2026-08-10",
      sunday: "2026-08-16",
    });
  });

  test("treats Monday as the start of the week", () => {
    assert.deepEqual(isoWeekBounds("2026-08-10"), {
      monday: "2026-08-10",
      sunday: "2026-08-16",
    });
  });

  test("treats Sunday as the END of the week, not the start", () => {
    assert.deepEqual(isoWeekBounds("2026-08-16"), {
      monday: "2026-08-10",
      sunday: "2026-08-16",
    });
  });

  test("spans a month boundary", () => {
    assert.deepEqual(isoWeekBounds("2026-09-01"), {
      monday: "2026-08-31",
      sunday: "2026-09-06",
    });
  });

  test("spans a year boundary", () => {
    assert.deepEqual(isoWeekBounds("2027-01-01"), {
      monday: "2026-12-28",
      sunday: "2027-01-03",
    });
  });
});
