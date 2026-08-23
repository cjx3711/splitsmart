/**
 * Simplify-debts: the settle-up matching, and the friend-balance rewrite that
 * uses it. Pure, so these pin the cycle that made an imported Splitwise friend
 * look unsettled when the group itself had netted to zero.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pairwiseWithSimplify, simplifyDebts } from "./settle.ts";

describe("simplifyDebts", () => {
  test("a two-person debt is itself", () => {
    assert.deepEqual(
      simplifyDebts([
        { userId: "a", amountMinor: 1000 },
        { userId: "b", amountMinor: -1000 },
      ]),
      [{ fromUserId: "b", toUserId: "a", amountMinor: 1000 }],
    );
  });

  test("a three-way cycle of nets that are already zero needs no transfers", () => {
    assert.deepEqual(
      simplifyDebts([
        { userId: "a", amountMinor: 0 },
        { userId: "b", amountMinor: 0 },
        { userId: "c", amountMinor: 0 },
      ]),
      [],
    );
  });

  test("throws when the nets do not sum to zero", () => {
    assert.throws(
      () =>
        simplifyDebts([
          { userId: "a", amountMinor: 10 },
          { userId: "b", amountMinor: -9 },
        ]),
      /sum to 1/,
    );
  });
});

describe("pairwiseWithSimplify", () => {
  const group = "g1";

  test("a cycle inside a simplified group disappears from the viewer's friends", () => {
    // A paid B, B paid C, C paid A, all 1000. Each net is 0; raw pairwise is not.
    const edges = pairwiseWithSimplify({
      viewerId: "a",
      raw: [
        { otherUserId: "b", groupId: group, currencyCode: "USD", amountMinor: 1000 },
        { otherUserId: "c", groupId: group, currencyCode: "USD", amountMinor: -1000 },
      ],
      nets: [
        { groupId: group, userId: "a", currencyCode: "USD", amountMinor: 0 },
        { groupId: group, userId: "b", currencyCode: "USD", amountMinor: 0 },
        { groupId: group, userId: "c", currencyCode: "USD", amountMinor: 0 },
      ],
      simplifyByGroupId: new Map([[group, true]]),
    });
    assert.deepEqual(edges, []);
  });

  test("the same cycle is left alone when the group has simplify off", () => {
    const raw = [
      { otherUserId: "b", groupId: group, currencyCode: "USD", amountMinor: 1000 },
      { otherUserId: "c", groupId: group, currencyCode: "USD", amountMinor: -1000 },
    ];
    const edges = pairwiseWithSimplify({
      viewerId: "a",
      raw,
      nets: [
        { groupId: group, userId: "a", currencyCode: "USD", amountMinor: 0 },
        { groupId: group, userId: "b", currencyCode: "USD", amountMinor: 0 },
        { groupId: group, userId: "c", currencyCode: "USD", amountMinor: 0 },
      ],
      simplifyByGroupId: new Map([[group, false]]),
    });
    assert.deepEqual(edges, raw);
  });

  test("reroutes a third-party debt onto the viewer, Splitwise-style", () => {
    // A is owed 100 by B. C is owed 40 by A. After simplify, B pays A 60 and C 40.
    const edges = pairwiseWithSimplify({
      viewerId: "a",
      raw: [
        { otherUserId: "b", groupId: group, currencyCode: "USD", amountMinor: 100 },
        { otherUserId: "c", groupId: group, currencyCode: "USD", amountMinor: -40 },
      ],
      nets: [
        { groupId: group, userId: "a", currencyCode: "USD", amountMinor: 60 },
        { groupId: group, userId: "b", currencyCode: "USD", amountMinor: -100 },
        { groupId: group, userId: "c", currencyCode: "USD", amountMinor: 40 },
      ],
      simplifyByGroupId: new Map([[group, true]]),
    });
    const byOther = new Map(edges.map((e) => [e.otherUserId, e.amountMinor]));
    assert.equal(byOther.get("b"), 60);
    assert.equal(byOther.has("c"), false);
  });

  test("never simplifies the one-on-one bucket", () => {
    const edges = pairwiseWithSimplify({
      viewerId: "a",
      raw: [
        { otherUserId: "b", groupId: null, currencyCode: "JPY", amountMinor: 1000 },
        { otherUserId: "c", groupId: null, currencyCode: "JPY", amountMinor: -1000 },
        { otherUserId: "b", groupId: group, currencyCode: "JPY", amountMinor: 50 },
      ],
      nets: [
        { groupId: null, userId: "a", currencyCode: "JPY", amountMinor: 0 },
        { groupId: null, userId: "b", currencyCode: "JPY", amountMinor: 0 },
        { groupId: null, userId: "c", currencyCode: "JPY", amountMinor: 0 },
        { groupId: group, userId: "a", currencyCode: "JPY", amountMinor: 50 },
        { groupId: group, userId: "b", currencyCode: "JPY", amountMinor: -50 },
      ],
      simplifyByGroupId: new Map([[group, false]]),
    });
    const byKey = new Map(edges.map((e) => [`${e.otherUserId}:${e.groupId ?? ""}`, e.amountMinor]));
    assert.equal(byKey.get("b:"), 1000);
    assert.equal(byKey.get("c:"), -1000);
    assert.equal(byKey.get(`b:${group}`), 50);
  });

  test("falls back to raw edges when a currency's nets do not sum to zero", () => {
    const raw = [
      { otherUserId: "b", groupId: group, currencyCode: "USD", amountMinor: 10 },
    ];
    const edges = pairwiseWithSimplify({
      viewerId: "a",
      raw,
      nets: [
        { groupId: group, userId: "a", currencyCode: "USD", amountMinor: 10 },
        { groupId: group, userId: "b", currencyCode: "USD", amountMinor: -9 },
      ],
      simplifyByGroupId: new Map([[group, true]]),
    });
    assert.deepEqual(edges, raw);
  });
});
