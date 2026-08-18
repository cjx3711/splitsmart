/**
 * The claim remap of a queued expense payload, as a pure function.
 *
 * Combining shares is the server's job. A second implementation here would
 * drift, so a payload that would name the survivor twice is a collision the
 * caller quarantines rather than a guessed sum. See docs/OFFLINE.md.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { remapPayloadUser } from "./remap.ts";

const GHOST = "01JGHOST000000000000000000";
const SURVIVOR = "01JSURVIVOR00000000000000";
const OWNER = "01JOWNER000000000000000000";

function payload(participants: string[]) {
  return {
    description: "Dinner",
    costMinor: 3000,
    currencyCode: "USD",
    participants: participants.map((userId, i) => ({
      userId,
      paidMinor: i === 0 ? 3000 : 0,
    })),
  };
}

describe("remapPayloadUser", () => {
  test("a pending create that named the ghost is remapped to the survivor", () => {
    const result = remapPayloadUser(payload([OWNER, GHOST]), GHOST, SURVIVOR);

    assert.notEqual(result, "collision");
    assert.deepEqual(
      (result as { participants: Array<{ userId: string }> }).participants.map((p) => p.userId),
      [OWNER, SURVIVOR],
    );
    assert.equal(
      (result as { participants: Array<{ paidMinor: number }> }).participants[1]!.paidMinor,
      0,
      "amounts travel with the id; they are not recomputed",
    );
  });

  test("a pending create that would name the survivor twice is a collision", () => {
    const result = remapPayloadUser(payload([SURVIVOR, GHOST]), GHOST, SURVIVOR);
    assert.equal(result, "collision", "combining paid/owed is not a client job");
  });

  test("a payload that never mentioned the ghost is left alone", () => {
    const original = payload([OWNER, SURVIVOR]);
    assert.equal(remapPayloadUser(original, GHOST, SURVIVOR), original);
  });

  test("a comment payload has no participants and is left alone", () => {
    const original = { expenseId: "01JEXPENSE0000000000000000", content: "note" };
    assert.equal(remapPayloadUser(original, GHOST, SURVIVOR), original);
  });

  test("null, a string, or a payload we cannot read is not mangled", () => {
    assert.equal(remapPayloadUser(null, GHOST, SURVIVOR), null);
    assert.equal(remapPayloadUser("queued", GHOST, SURVIVOR), "queued");
    const left = remapPayloadUser({ description: "Dinner" }, GHOST, SURVIVOR);
    assert.deepEqual(left, { description: "Dinner" });
  });
});
