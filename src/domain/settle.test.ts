/**
 * Simplify-debts: the settle-up matching, and the friend-balance rewrite that
 * uses it. Pure, so these pin the cycle that made an imported Splitwise friend
 * look unsettled when the group itself had netted to zero.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { pairwiseWithSimplify, planSettleAll, settleSuggestions, simplifyDebts } from "./settle.ts";

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

describe("planSettleAll", () => {
  test("zeroes a group and one-on-one bucket that cancel out overall", () => {
    const transfers = planSettleAll("a", "b", [
      { groupId: "g1", balances: [{ currencyCode: "JPY", amountMinor: -3663 }] },
      { groupId: null, balances: [{ currencyCode: "JPY", amountMinor: 3663 }] },
    ]);
    assert.deepEqual(
      transfers.sort((x, y) => (x.groupId ?? "").localeCompare(y.groupId ?? "")),
      [
        { groupId: null, currencyCode: "JPY", fromUserId: "b", toUserId: "a", amountMinor: 3663 },
        { groupId: "g1", currencyCode: "JPY", fromUserId: "a", toUserId: "b", amountMinor: 3663 },
      ],
    );
  });

  test("leaves a currency alone when it does not net to zero overall", () => {
    const transfers = planSettleAll("a", "b", [
      { groupId: "g1", balances: [{ currencyCode: "USD", amountMinor: -1000 }] },
      { groupId: null, balances: [{ currencyCode: "USD", amountMinor: 500 }] },
    ]);
    assert.deepEqual(transfers, []);
  });

  test("does nothing when every bucket is already settled", () => {
    assert.deepEqual(
      planSettleAll("a", "b", [{ groupId: "g1", balances: [] }]),
      [],
    );
  });

  test("settles one currency while leaving an unrelated unsettled one alone", () => {
    const transfers = planSettleAll("a", "b", [
      {
        groupId: "g1",
        balances: [
          { currencyCode: "JPY", amountMinor: -3663 },
          { currencyCode: "USD", amountMinor: -1000 },
        ],
      },
      { groupId: null, balances: [{ currencyCode: "JPY", amountMinor: 3663 }] },
    ]);
    assert.deepEqual(
      transfers.map((t) => t.currencyCode).sort(),
      ["JPY", "JPY"],
    );
  });
});

describe("settleSuggestions", () => {
  // A cycle: a paid for b, b paid for c, c paid for a, one unit each. Nets are
  // all zero, so simplify clears the group with nothing at all - and the raw
  // answer is three real payments nobody can skip.
  const cycle = [
    { fromUserId: "a", toUserId: "b", currencyCode: "USD", amountMinor: 1000 },
    { fromUserId: "b", toUserId: "c", currencyCode: "USD", amountMinor: 1000 },
    { fromUserId: "c", toUserId: "a", currencyCode: "USD", amountMinor: 1000 },
  ];

  test("simplify on collapses a cycle to nothing", () => {
    assert.deepEqual(
      settleSuggestions({ simplify: true, members: [], edges: cycle }),
      [],
    );
  });

  test("simplify off keeps every recorded debt in the cycle", () => {
    const sets = settleSuggestions({ simplify: false, members: [], edges: cycle });
    assert.equal(sets.length, 1);
    assert.equal(sets[0]!.currencyCode, "USD");
    assert.deepEqual(sets[0]!.transfers, [
      { fromUserId: "a", toUserId: "b", amountMinor: 1000 },
      { fromUserId: "b", toUserId: "c", amountMinor: 1000 },
      { fromUserId: "c", toUserId: "a", amountMinor: 1000 },
    ]);
  });

  test("simplify off nets opposite directions between the same pair", () => {
    const sets = settleSuggestions({
      simplify: false,
      members: [],
      edges: [
        { fromUserId: "a", toUserId: "b", currencyCode: "USD", amountMinor: 1000 },
        { fromUserId: "b", toUserId: "a", currencyCode: "USD", amountMinor: 400 },
      ],
    });
    assert.deepEqual(sets, [
      { currencyCode: "USD", transfers: [{ fromUserId: "a", toUserId: "b", amountMinor: 600 }] },
    ]);
  });

  test("simplify off drops a pair that has cancelled out", () => {
    assert.deepEqual(
      settleSuggestions({
        simplify: false,
        members: [],
        edges: [
          { fromUserId: "a", toUserId: "b", currencyCode: "USD", amountMinor: 1000 },
          { fromUserId: "b", toUserId: "a", currencyCode: "USD", amountMinor: 1000 },
        ],
      }),
      [],
    );
  });

  test("simplify off never reroutes a debt onto a third party", () => {
    // b owes a, and c owes a. Raw and simplified agree here, which is exactly
    // why the toggle looks inert on a group with one habitual payer.
    const edges = [
      { fromUserId: "b", toUserId: "a", currencyCode: "USD", amountMinor: 1000 },
      { fromUserId: "c", toUserId: "a", currencyCode: "USD", amountMinor: 500 },
    ];
    const members = [
      { userId: "a", balances: [{ currencyCode: "USD", amountMinor: 1500 }] },
      { userId: "b", balances: [{ currencyCode: "USD", amountMinor: -1000 }] },
      { userId: "c", balances: [{ currencyCode: "USD", amountMinor: -500 }] },
    ];
    assert.deepEqual(
      settleSuggestions({ simplify: false, members, edges }),
      settleSuggestions({ simplify: true, members, edges }),
    );
  });

  test("currencies come back in a stable order, whichever mode", () => {
    const edges = [
      { fromUserId: "a", toUserId: "b", currencyCode: "USD", amountMinor: 100 },
      { fromUserId: "a", toUserId: "b", currencyCode: "JPY", amountMinor: 100 },
      { fromUserId: "a", toUserId: "b", currencyCode: "SGD", amountMinor: 100 },
    ];
    const members = [
      {
        userId: "a",
        balances: [
          { currencyCode: "USD", amountMinor: -100 },
          { currencyCode: "JPY", amountMinor: -100 },
          { currencyCode: "SGD", amountMinor: -100 },
        ],
      },
      {
        userId: "b",
        balances: [
          { currencyCode: "USD", amountMinor: 100 },
          { currencyCode: "JPY", amountMinor: 100 },
          { currencyCode: "SGD", amountMinor: 100 },
        ],
      },
    ];
    for (const simplify of [true, false]) {
      assert.deepEqual(
        settleSuggestions({ simplify, members, edges }).map((s) => s.currencyCode),
        ["JPY", "SGD", "USD"],
      );
    }
  });

  test("simplify off is unaffected by the member nets it does not read", () => {
    assert.deepEqual(
      settleSuggestions({
        simplify: false,
        members: [{ userId: "z", balances: [{ currencyCode: "USD", amountMinor: 99 }] }],
        edges: [{ fromUserId: "a", toUserId: "b", currencyCode: "USD", amountMinor: 1000 }],
      }),
      [{ currencyCode: "USD", transfers: [{ fromUserId: "a", toUserId: "b", amountMinor: 1000 }] }],
    );
  });
});
