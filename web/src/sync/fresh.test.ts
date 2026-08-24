import { test } from "node:test";
import assert from "node:assert/strict";
import { queryToken, takeFresh } from "./fresh.ts";

test("a result from the current deps is kept", () => {
  const token = queryToken(["friend-b"]);
  assert.equal(takeFresh({ token, value: { id: "friend-b" } }, token)?.id, "friend-b");
});

test("a result from the previous friend is treated as unresolved", () => {
  const previous = queryToken(["friend-a"]);
  const current = queryToken(["friend-b"]);
  assert.equal(takeFresh({ token: previous, value: { id: "friend-a" } }, current), undefined);
});

test("an unresolved query stays unresolved", () => {
  assert.equal(takeFresh(undefined, queryToken(["friend-b"])), undefined);
});

test("the token distinguishes a missing id from a present one", () => {
  assert.notEqual(queryToken([undefined]), queryToken(["friend-a"]));
});
