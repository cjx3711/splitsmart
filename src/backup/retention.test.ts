import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  dailyKey,
  parseDailyDate,
  parseWeeklyDate,
  selectDailyKeysToPrune,
  summariseObjectSizes,
  weeklyKey,
} from "./retention.ts";
import { normaliseKeyPrefix } from "./config.ts";

const TODAY = "2026-08-14";

// Both prefix modes are covered throughout, because the empty-prefix case
// is the one that silently broke retention: with no prefix the key is
// `daily/<date>.sqlite.gz` with NO leading slash, so a `/\/daily\//`
// pattern would match nothing and prune forever.
const PREFIXES = [
  { label: "with a prefix", prefix: "splitsmart/" },
  { label: "with an empty prefix", prefix: "" },
];

describe("key builders", () => {
  test("build keys that are a pure function of the date", () => {
    assert.equal(dailyKey("splitsmart/", TODAY), "splitsmart/daily/2026-08-14.sqlite.gz");
    assert.equal(weeklyKey("splitsmart/", TODAY), "splitsmart/weekly/2026-08-14.sqlite.gz");
    assert.equal(dailyKey("", TODAY), "daily/2026-08-14.sqlite.gz");
    assert.equal(weeklyKey("", TODAY), "weekly/2026-08-14.sqlite.gz");
  });

  test("round-trips through the parsers in both prefix modes", () => {
    for (const { prefix } of PREFIXES) {
      assert.equal(parseDailyDate(dailyKey(prefix, TODAY)), TODAY);
      assert.equal(parseWeeklyDate(weeklyKey(prefix, TODAY)), TODAY);
      assert.equal(parseWeeklyDate(dailyKey(prefix, TODAY)), null);
      assert.equal(parseDailyDate(weeklyKey(prefix, TODAY)), null);
    }
  });

  test("does not parse keys that only look right", () => {
    assert.equal(parseDailyDate("splitsmart/daily/2026-08-14.sqlite"), null);
    assert.equal(parseDailyDate("splitsmart/daily/latest.sqlite.gz"), null);
    assert.equal(parseDailyDate("splitsmart/dailyish/2026-08-14.sqlite.gz"), null);
    assert.equal(parseDailyDate("splitsmart/daily/2026-08-14.sqlite.gz.tmp"), null);
  });
});

describe("normaliseKeyPrefix", () => {
  test("normalises to no leading slash and exactly one trailing slash", () => {
    assert.equal(normaliseKeyPrefix("splitsmart"), "splitsmart/");
    assert.equal(normaliseKeyPrefix("splitsmart/"), "splitsmart/");
    assert.equal(normaliseKeyPrefix("splitsmart//"), "splitsmart/");
    assert.equal(normaliseKeyPrefix("/splitsmart/"), "splitsmart/");
    assert.equal(normaliseKeyPrefix("//a/b//"), "a/b/");
  });

  test("keeps an explicitly empty prefix empty", () => {
    assert.equal(normaliseKeyPrefix(""), "");
    assert.equal(normaliseKeyPrefix("   "), "");
    assert.equal(normaliseKeyPrefix("/"), "");
  });
});

describe("selectDailyKeysToPrune", () => {
  for (const { label, prefix } of PREFIXES) {
    describe(label, () => {
      const key = (date: string) => dailyKey(prefix, date);

      test("keeps today plus the previous six days and deletes the rest", () => {
        const keys = [
          key("2026-08-14"),
          key("2026-08-09"),
          key("2026-08-08"),
          key("2026-08-07"),
          key("2026-08-01"),
          key("2026-07-30"),
        ];

        const { toDelete, skipped, refusal } = selectDailyKeysToPrune(keys, TODAY, 7);

        assert.equal(refusal, null);
        assert.deepEqual(skipped, []);
        assert.deepEqual(
          [...toDelete].sort(),
          [key("2026-08-07"), key("2026-08-01"), key("2026-07-30")].sort(),
        );
      });

      test("deletes nothing when everything is inside the window", () => {
        const keys = [key("2026-08-14"), key("2026-08-13"), key("2026-08-08")];
        assert.deepEqual(selectDailyKeysToPrune(keys, TODAY, 7).toDelete, []);
      });

      test("honours a retention of 1 day", () => {
        const keys = [key("2026-08-14"), key("2026-08-13")];
        assert.deepEqual(selectDailyKeysToPrune(keys, TODAY, 1).toDelete, [
          key("2026-08-13"),
        ]);
      });

      test("never deletes a key it cannot parse", () => {
        const unparseable = `${prefix}daily/notes.txt`;
        const keys = [key("2026-01-01"), unparseable];
        const { toDelete, skipped } = selectDailyKeysToPrune(keys, TODAY, 7);
        assert.deepEqual(toDelete, [key("2026-01-01")]);
        assert.deepEqual(skipped, [unparseable]);
      });

      test("never deletes weekly objects", () => {
        const stray = weeklyKey(prefix, "2026-01-05");
        const { toDelete, skipped } = selectDailyKeysToPrune([stray], TODAY, 7);
        assert.deepEqual(toDelete, []);
        assert.deepEqual(skipped, [stray]);
      });

      test("refuses when the clock has clearly jumped backwards", () => {
        const keys = [key("2026-08-14")];
        const { toDelete, refusal } = selectDailyKeysToPrune(keys, "2025-12-31", 7);
        assert.deepEqual(toDelete, []);
        assert.match(refusal ?? "", /clock is wrong/);
      });

      test("refuses a mass deletion that looks like a forward clock jump", () => {
        const keys = [
          key("2026-08-14"),
          ...Array.from({ length: 20 }, (_, index) =>
            key(`2026-07-${String(index + 1).padStart(2, "0")}`),
          ),
        ];
        const { toDelete, refusal } = selectDailyKeysToPrune(keys, TODAY, 7);
        assert.deepEqual(toDelete, []);
        assert.match(refusal ?? "", /clock jump/);
      });

      test("still prunes a small number of objects even if it is most of the bucket", () => {
        const keys = [key("2026-08-14"), key("2026-08-01"), key("2026-07-31")];
        assert.deepEqual(
          [...selectDailyKeysToPrune(keys, TODAY, 7).toDelete].sort(),
          [key("2026-08-01"), key("2026-07-31")].sort(),
        );
      });
    });
  }
});

describe("summariseObjectSizes", () => {
  test("sums daily and weekly objects independently", () => {
    assert.deepEqual(
      summariseObjectSizes([{ size: 10 }, { size: 20 }], [{ size: 5 }]),
      {
        totalBytes: 35,
        dailyBytes: 30,
        weeklyBytes: 5,
        dailyObjectCount: 2,
        weeklyObjectCount: 1,
      },
    );
  });

  test("treats an empty bucket as zeros, not as missing", () => {
    assert.deepEqual(summariseObjectSizes([], []), {
      totalBytes: 0,
      dailyBytes: 0,
      weeklyBytes: 0,
      dailyObjectCount: 0,
      weeklyObjectCount: 0,
    });
  });
});
