import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ulid, ulidTime, isUlid } from "./ulid.ts";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

describe("ulid", () => {
  test("is 26 Crockford characters", () => {
    const id = ulid();
    assert.equal(id.length, 26);
    assert.match(id, CROCKFORD);
    assert.ok(isUlid(id));
  });

  test("does not emit I, L, O, or U", () => {
    for (let i = 0; i < 200; i++) {
      assert.doesNotMatch(ulid(), /[ILOU]/);
    }
  });

  test("two calls are unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(ulid());
    assert.equal(seen.size, 200);
  });

  test("sorts by timestamp", () => {
    const earlier = ulid(1_000_000);
    const later = ulid(2_000_000);
    assert.ok(earlier < later);
  });

  test("the same timestamp still produces distinct ids", () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_000);
    assert.notEqual(a, b);
    assert.equal(a.slice(0, 10), b.slice(0, 10));
  });

  test("ulidTime round-trips the injected timestamp", () => {
    const now = 1_700_000_000_000;
    assert.equal(ulidTime(ulid(now)), now);
  });
});

describe("isUlid", () => {
  test("accepts a generated ULID", () => {
    assert.equal(isUlid(ulid()), true);
  });

  test("rejects the wrong length, alphabet, or type", () => {
    assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FA"), false); // 25
    assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAVV"), false); // 27
    assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAI"), false); // I
    assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAL"), false); // L
    assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAO"), false); // O
    assert.equal(isUlid("01ARZ3NDEKTSV4RRFFQ69G5FAU"), false); // U
    assert.equal(isUlid("01arz3ndektsv4rrffq69g5fav"), false); // lowercase
    assert.equal(isUlid("not-a-ulid"), false);
    assert.equal(isUlid(1), false);
    assert.equal(isUlid(null), false);
    assert.equal(isUlid(undefined), false);
  });
});
