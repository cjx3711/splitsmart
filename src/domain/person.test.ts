import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  avatarHue,
  defaultIconLetters,
  displayName,
  graphemes,
  hueFromId,
  iconLettersOf,
} from "./person.ts";

describe("displayName", () => {
  test("nickname wins when set", () => {
    assert.equal(displayName({ name: "Tanaka Yuki", nickname: "Yuki" }), "Yuki");
  });

  test("falls back to name", () => {
    assert.equal(displayName({ name: "Tanaka Yuki", nickname: null }), "Tanaka Yuki");
    assert.equal(displayName({ name: "Tanaka Yuki", nickname: "  " }), "Tanaka Yuki");
  });
});

describe("defaultIconLetters", () => {
  test("two whitespace-separated words take one grapheme each", () => {
    assert.equal(defaultIconLetters({ name: "Tanaka Yuki" }), "TY");
    assert.equal(defaultIconLetters({ name: "jamie lee" }), "JL");
  });

  test("a single word is the first grapheme, not a guessed surname", () => {
    assert.equal(defaultIconLetters({ name: "Madonna" }), "M");
    assert.equal(defaultIconLetters({ name: "田中雪" }), "田");
  });

  test("uses the nickname when that is what we display", () => {
    assert.equal(defaultIconLetters({ name: "Tanaka Yuki", nickname: "Yuki" }), "Y");
  });
});

describe("iconLettersOf", () => {
  test("custom letters win", () => {
    assert.equal(
      iconLettersOf({ name: "Tanaka Yuki", iconLetters: "雪" }),
      "雪",
    );
  });
});

describe("graphemes", () => {
  test("treats a ZWJ emoji sequence as one cluster", () => {
    assert.equal(graphemes("👨‍👩‍👧").length, 1);
  });
});

describe("avatarHue", () => {
  test("stored hue wins over the id hash", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    assert.equal(avatarHue({ id, iconHue: 48 }), 48);
    assert.equal(avatarHue({ id, iconHue: null }), hueFromId(id));
  });
});
