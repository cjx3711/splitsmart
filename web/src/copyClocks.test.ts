import { test } from "node:test";
import assert from "node:assert/strict";
import { copyRelation, parseLogTime } from "./copyClocks.ts";

test("two empty clocks match, unless this device has unsaved writes", () => {
  assert.equal(copyRelation(null, null).kind, "match");
  assert.equal(copyRelation(null, null).label, "Match");
  assert.equal(copyRelation(null, null, 1).kind, "ahead");
  assert.equal(copyRelation(null, null, 1).label, "Ahead · not saved yet");
});

test("the same timestamp is a match", () => {
  const at = "2026-08-24 10:58:56";
  const same = copyRelation(at, at);
  assert.equal(same.kind, "match");
  assert.equal(same.label, "Match");
  assert.equal(same.sentence, "This copy matches the server.");
});

test("a later server clock is behind", () => {
  const relation = copyRelation("2026-08-24 11:01:56", "2026-08-24 10:58:56");
  assert.equal(relation.kind, "behind");
  assert.equal(relation.label, "Behind · 3 minutes");
  assert.equal(relation.sentence, "This copy is 3 minutes behind the server.");
});

test("a later device clock is ahead", () => {
  const relation = copyRelation("2026-08-24 10:58:56", "2026-08-24 11:00:56");
  assert.equal(relation.kind, "ahead");
  assert.equal(relation.label, "Ahead · 2 minutes");
  assert.equal(relation.sentence, "This copy is 2 minutes ahead of the server.");
});

test("only the server having a clock is behind", () => {
  const relation = copyRelation("2026-08-24 10:58:56", null);
  assert.equal(relation.kind, "behind");
  assert.equal(relation.label, "Behind");
});

test("only this device having a clock is ahead", () => {
  const relation = copyRelation(null, "2026-08-24 10:58:56");
  assert.equal(relation.kind, "ahead");
  assert.equal(relation.label, "Ahead");
});

test("matching times with a pending write are ahead", () => {
  const at = "2026-08-24 10:58:56";
  const relation = copyRelation(at, at, 2);
  assert.equal(relation.kind, "ahead");
  assert.equal(relation.label, "Ahead · not saved yet");
  assert.equal(relation.sentence, "Changes on this device are waiting to be saved.");
});

test("sqlite timestamps without a timezone parse as UTC", () => {
  assert.equal(parseLogTime("2026-08-24 10:58:56"), Date.parse("2026-08-24T10:58:56Z"));
  assert.equal(parseLogTime("2026-08-24T10:58:56.000Z"), Date.parse("2026-08-24T10:58:56.000Z"));
});
