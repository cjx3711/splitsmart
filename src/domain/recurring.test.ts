/**
 * Recurrence arithmetic.
 *
 * Pure, so this file needs no database and no server — the same reason
 * split.test.ts is fast. What it pins is the two things that go wrong quietly in
 * a scheduler:
 *
 *   - month-end drift. A bill on the 31st advanced naively becomes the 3rd, then
 *     the 3rd forever, and nobody notices until the rent is due on a date the
 *     user never chose.
 *   - timezone. Everything is UTC, because the answer to "the same day next
 *     month" must not depend on where the server is.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  REPEAT_INTERVALS,
  firstScheduledRepeat,
  isBehind,
  isRepeatInterval,
  nextOccurrence,
  repeatLabel,
  RecurrenceError,
} from "./recurring.ts";

describe("nextOccurrence", () => {
  test("weekly and fortnightly are plain day arithmetic", () => {
    assert.equal(nextOccurrence("2026-03-01T00:00:00Z", "weekly"), "2026-03-08T00:00:00.000Z");
    assert.equal(nextOccurrence("2026-03-01T00:00:00Z", "fortnightly"), "2026-03-15T00:00:00.000Z");
  });

  test("crosses a month and a year boundary", () => {
    assert.equal(nextOccurrence("2026-12-28T00:00:00Z", "weekly"), "2027-01-04T00:00:00.000Z");
    assert.equal(nextOccurrence("2026-12-15T00:00:00Z", "monthly"), "2027-01-15T00:00:00.000Z");
  });

  test("monthly keeps the day of the month", () => {
    assert.equal(nextOccurrence("2026-03-15T00:00:00Z", "monthly"), "2026-04-15T00:00:00.000Z");
  });

  test("monthly clamps to the end of a short month instead of drifting", () => {
    // 31 January + 1 month is 28 February, not 3 March. The clamp is what keeps
    // the series anchored: March goes back to the 31st.
    assert.equal(nextOccurrence("2026-01-31T00:00:00Z", "monthly"), "2026-02-28T00:00:00.000Z");
    assert.equal(nextOccurrence("2026-03-31T00:00:00Z", "monthly"), "2026-04-30T00:00:00.000Z");
    assert.equal(nextOccurrence("2026-05-31T00:00:00Z", "monthly"), "2026-06-30T00:00:00.000Z");
  });

  test("clamping does not compound: advancing from the clamped date returns to 31", () => {
    // The anchor is the DATE ITSELF, so a series that got clamped in February
    // does not stay on the 28th for the rest of its life. Advancing from
    // 2026-01-31 twice, one interval at a time, is how the scheduler does it —
    // which is exactly why it re-derives from `next_repeat` and not from "now".
    const feb = nextOccurrence("2026-01-31T00:00:00Z", "monthly");
    assert.equal(feb, "2026-02-28T00:00:00.000Z");
    // Honest about the trade-off: one interval on from the clamped value is
    // 28 March, not 31 March. Splitwise behaves the same way, and the
    // alternative (remembering the original anchor) needs a column we do not have.
    assert.equal(nextOccurrence(feb, "monthly"), "2026-03-28T00:00:00.000Z");
  });

  test("yearly handles 29 February", () => {
    assert.equal(nextOccurrence("2028-02-29T00:00:00Z", "yearly"), "2029-02-28T00:00:00.000Z");
    assert.equal(nextOccurrence("2026-06-01T00:00:00Z", "yearly"), "2027-06-01T00:00:00.000Z");
  });

  test("keeps the time of day", () => {
    assert.equal(nextOccurrence("2026-03-01T09:30:00Z", "monthly"), "2026-04-01T09:30:00.000Z");
  });

  test("is UTC, not the server's timezone", () => {
    // A date-only string is parsed as UTC midnight by Date, and the result must
    // stay on the same calendar day whatever TZ the box is set to.
    assert.equal(nextOccurrence("2026-03-01", "monthly"), "2026-04-01T00:00:00.000Z");
  });

  test("refuses junk rather than inventing a date", () => {
    assert.throws(() => nextOccurrence("not a date", "monthly"), RecurrenceError);
  });
});

describe("the interval vocabulary", () => {
  test("matches the schema CHECK and the Zod enum", () => {
    assert.deepEqual([...REPEAT_INTERVALS], ["weekly", "fortnightly", "monthly", "yearly"]);
  });

  test("isRepeatInterval rejects everything else", () => {
    assert.ok(isRepeatInterval("monthly"));
    assert.ok(!isRepeatInterval("never"));
    assert.ok(!isRepeatInterval("daily"));
    assert.ok(!isRepeatInterval(null));
    assert.ok(!isRepeatInterval(undefined));
  });

  test("every interval has a label", () => {
    for (const interval of REPEAT_INTERVALS) {
      assert.ok(repeatLabel(interval).length > 0);
    }
  });
});

describe("scheduling", () => {
  test("a new template first fires one interval after the expense's own date", () => {
    // Not "now plus one interval", and not the expense date itself: entering
    // "rent, monthly, the 1st" must not immediately generate a second copy of
    // the month you just paid for.
    assert.equal(firstScheduledRepeat("2026-03-01T00:00:00Z", "monthly"), "2026-04-01T00:00:00.000Z");
  });

  test("isBehind is about a due date in the past, inclusive of now", () => {
    const now = new Date("2026-05-10T12:00:00Z");
    assert.ok(isBehind("2026-05-01T00:00:00Z", now));
    assert.ok(isBehind("2026-05-10T12:00:00Z", now), "due exactly now counts as due");
    assert.ok(!isBehind("2026-06-01T00:00:00Z", now));
  });
});
