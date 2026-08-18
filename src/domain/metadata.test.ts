import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseMetadata,
  serializeMetadata,
  splitwiseIdOf,
  metadataFromSplitwise,
  metadataWithSplitwiseId,
  repeatPausedOf,
} from "./metadata.ts";

describe("parseMetadata", () => {
  test("empty and invalid input become {}", () => {
    assert.deepEqual(parseMetadata(null), {});
    assert.deepEqual(parseMetadata(""), {});
    assert.deepEqual(parseMetadata("[]"), {});
    assert.deepEqual(parseMetadata("not json"), {});
    assert.deepEqual(parseMetadata("null"), {});
  });

  test("keeps known keys and extras", () => {
    const raw = serializeMetadata({ splitwise_id: 9, notes: "hello", leftover: true });
    const parsed = parseMetadata(raw);
    assert.equal(parsed.splitwise_id, 9);
    assert.equal(parsed.notes, "hello");
    assert.equal(parsed.leftover, true);
  });
});

describe("splitwiseIdOf", () => {
  test("reads an integer and rejects anything else", () => {
    assert.equal(splitwiseIdOf(metadataFromSplitwise(42)), 42);
    assert.equal(splitwiseIdOf("{}"), null);
    assert.equal(splitwiseIdOf(serializeMetadata({ splitwise_id: 1.5 })), null);
  });
});

describe("repeatPausedOf", () => {
  test("reads a known interval and rejects anything else", () => {
    assert.equal(repeatPausedOf(serializeMetadata({ repeat_paused: "monthly" })), "monthly");
    assert.equal(repeatPausedOf("{}"), null);
    assert.equal(repeatPausedOf(serializeMetadata({ repeat_paused: "daily" })), null);
  });
});

describe("metadataWithSplitwiseId", () => {
  test("stamps without clobbering notes, and does not overwrite an existing id", () => {
    const first = metadataWithSplitwiseId(serializeMetadata({ notes: "keep me" }), 7);
    assert.equal(splitwiseIdOf(first), 7);
    assert.equal(parseMetadata(first).notes, "keep me");

    const second = metadataWithSplitwiseId(first, 99);
    assert.equal(splitwiseIdOf(second), 7);
  });
});
