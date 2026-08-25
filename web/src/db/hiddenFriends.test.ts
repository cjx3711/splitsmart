import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { friendIsHidden, hideFriend } from "./hiddenFriends.ts";

const older = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
const newer = "01ARZ3NDEKTSV4RRFFQ69G5FAB";

describe("friendIsHidden", () => {
  test("an unlisted friend stays on the rail", () => {
    assert.equal(friendIsHidden(undefined, older, false), false);
  });

  test("a hide without newer activity takes them off the rail", () => {
    assert.equal(friendIsHidden(older, older, false), true);
    assert.equal(friendIsHidden(newer, older, false), true);
    assert.equal(friendIsHidden("", "", false), true);
  });

  test("a newer shared expense brings them back", () => {
    assert.equal(friendIsHidden(older, newer, false), false);
    assert.equal(friendIsHidden("", older, false), false);
  });

  test("search shows them even when hidden", () => {
    assert.equal(friendIsHidden(older, older, true), false);
    assert.equal(friendIsHidden(newer, older, true), false);
  });
});

describe("hideFriend", () => {
  test("snapshots the current last expense, overwriting a previous hide", () => {
    const first = hideFriend({}, "poh", older);
    assert.deepEqual(first, { poh: older });
    assert.deepEqual(hideFriend(first, "poh", newer), { poh: newer });
  });
});
