/**
 * The outbox reducer and pull-versus-pending policy, as a pure function.
 *
 * These are the decisions that lose money if they are wrong, and they are
 * testable without a browser precisely because web/src/sync/outbox.ts imports
 * nothing that needs one. The cases are the table in docs/OFFLINE.md.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  reduceOutbox,
  reconcileRemote,
  sortForPush,
  type LocalWrite,
} from "./outbox.ts";
import type { OutboxOp } from "../db/local.ts";

const AT = "2026-06-01T12:00:00.000Z";
const ID = "01JOUTBOXTESTEXPENSE000001";
const payload = { description: "Dinner", costMinor: 3000, currencyCode: "USD" };

function pending(kind: OutboxOp["kind"], extra: Partial<OutboxOp> = {}): OutboxOp {
  return {
    seq: 1,
    id: ID,
    kind,
    baseVersion: extra.baseVersion ?? (kind.startsWith("comment.") || kind.endsWith(".create") ? null : 3),
    payload: extra.payload ?? (kind.endsWith(".create") || kind === "expense.update" ? payload : null),
    status: "pending",
    reason: null,
    queuedAt: AT,
    ...extra,
  };
}

function decide(queued: OutboxOp | undefined, write: LocalWrite) {
  return reduceOutbox(queued, write, AT);
}

describe("reduceOutbox - nothing queued", () => {
  test("create becomes a pending create", () => {
    const d = decide(undefined, { kind: "expense.create", id: ID, payload: payload as never });
    assert.equal(d.action, "insert");
    if (d.action === "insert") {
      assert.equal(d.entry.kind, "expense.create");
      assert.equal(d.entry.baseVersion, null);
    }
  });

  test("edit freezes baseVersion", () => {
    const d = decide(undefined, {
      kind: "expense.update",
      id: ID,
      payload: payload as never,
      baseVersion: 4,
    });
    assert.equal(d.action, "insert");
    if (d.action === "insert") assert.equal(d.entry.baseVersion, 4);
  });

  test("delete of a synced row is a pending delete", () => {
    const d = decide(undefined, { kind: "expense.delete", id: ID, baseVersion: 2 });
    assert.equal(d.action, "insert");
    if (d.action === "insert") {
      assert.equal(d.entry.kind, "expense.delete");
      assert.equal(d.entry.baseVersion, 2);
    }
  });

  test("restore of a synced tombstone freezes baseVersion", () => {
    const d = decide(undefined, { kind: "expense.restore", id: ID, baseVersion: 5 });
    assert.equal(d.action, "insert");
    if (d.action === "insert") assert.equal(d.entry.kind, "expense.restore");
  });
});

describe("reduceOutbox - folding", () => {
  test("edit of a pending create stays a create with the new payload", () => {
    const d = decide(pending("expense.create"), {
      kind: "expense.update",
      id: ID,
      payload: { ...payload, description: "Lunch" } as never,
      baseVersion: 1,
    });
    assert.equal(d.action, "replace");
    if (d.action === "replace") {
      assert.equal(d.entry.kind, "expense.create");
      assert.equal(d.entry.baseVersion, null);
      assert.equal((d.entry.payload as { description: string }).description, "Lunch");
    }
  });

  test("delete of a pending create drops the entry", () => {
    assert.equal(decide(pending("expense.create"), { kind: "expense.delete", id: ID, baseVersion: 1 }).action, "drop");
  });

  test("ten edits keep the original baseVersion", () => {
    let queued: OutboxOp | undefined = pending("expense.update", { baseVersion: 7 });
    for (let i = 0; i < 10; i++) {
      const d = decide(queued, {
        kind: "expense.update",
        id: ID,
        payload: { ...payload, description: `Edit ${i}` } as never,
        baseVersion: 99,
      });
      assert.equal(d.action, "replace");
      if (d.action !== "replace") return;
      queued = { ...d.entry, seq: 1 };
    }
    assert.equal(queued?.baseVersion, 7);
  });

  test("delete of a pending update becomes a delete at the same base", () => {
    const d = decide(pending("expense.update", { baseVersion: 3 }), {
      kind: "expense.delete",
      id: ID,
      baseVersion: 9,
    });
    assert.equal(d.action, "replace");
    if (d.action === "replace") {
      assert.equal(d.entry.kind, "expense.delete");
      assert.equal(d.entry.baseVersion, 3);
    }
  });

  test("restore of a pending delete drops the entry", () => {
    assert.equal(
      decide(pending("expense.delete"), { kind: "expense.restore", id: ID, baseVersion: 3 }).action,
      "drop",
    );
  });

  test("edit of a pending restore stays a restore with payload", () => {
    const d = decide(pending("expense.restore", { baseVersion: 4 }), {
      kind: "expense.update",
      id: ID,
      payload: payload as never,
      baseVersion: 4,
    });
    assert.equal(d.action, "replace");
    if (d.action === "replace") {
      assert.equal(d.entry.kind, "expense.restore");
      assert.equal(d.entry.baseVersion, 4);
      assert.deepEqual(d.entry.payload, payload);
    }
  });

  test("delete of a pending restore drops the entry", () => {
    assert.equal(
      decide(pending("expense.restore"), { kind: "expense.delete", id: ID, baseVersion: 4 }).action,
      "drop",
    );
  });

  test("delete of a pending comment create drops the entry", () => {
    assert.equal(
      decide(pending("comment.create"), { kind: "comment.delete", id: ID }).action,
      "drop",
    );
  });

  test("edit of a pending payment create stays a payment create", () => {
    const d = decide(pending("payment.create"), {
      kind: "expense.update",
      id: ID,
      payload: { ...payload, description: "Settled" } as never,
      baseVersion: 1,
    });
    assert.equal(d.action, "replace");
    if (d.action === "replace") {
      assert.equal(d.entry.kind, "payment.create");
      assert.equal(d.entry.baseVersion, null);
      assert.equal((d.entry.payload as { description: string }).description, "Settled");
    }
  });

  test("edit of a pending delete is ignored, not a resurrection", () => {
    const d = decide(pending("expense.delete"), {
      kind: "expense.update",
      id: ID,
      payload: payload as never,
      baseVersion: 3,
    });
    assert.equal(d.action, "ignore");
  });

  test("restore of a live pending create is ignored", () => {
    const d = decide(pending("expense.create"), { kind: "expense.restore", id: ID, baseVersion: 1 });
    assert.equal(d.action, "ignore");
  });
});

describe("reconcileRemote", () => {
  test("delete and forget always win", () => {
    for (const type of ["delete", "forget"] as const) {
      const r = reconcileRemote(pending("expense.update"), { type });
      assert.equal(r.applyRemote, true);
      assert.equal(r.keepPending, false);
      assert.equal(r.conflict, false);
    }
  });

  test("pending create ignores a remote upsert", () => {
    const r = reconcileRemote(pending("expense.create"), { type: "upsert" });
    assert.equal(r.applyRemote, false);
    assert.equal(r.keepPending, true);
    assert.equal(r.conflict, false);
  });

  test("pending update is not overwritten by a remote upsert", () => {
    const r = reconcileRemote(pending("expense.update"), { type: "upsert" });
    assert.equal(r.applyRemote, false);
    assert.equal(r.keepPending, true);
    assert.equal(r.conflict, false);
  });

  test("pending delete vs a live remote row is a conflict", () => {
    const r = reconcileRemote(pending("expense.delete"), { type: "upsert" });
    assert.equal(r.applyRemote, false);
    assert.equal(r.keepPending, true);
    assert.equal(r.conflict, true);
  });

  test("pending restore vs a remote upsert is kept, not overwritten", () => {
    const r = reconcileRemote(pending("expense.restore"), { type: "upsert" });
    assert.equal(r.applyRemote, false);
    assert.equal(r.keepPending, true);
    assert.equal(r.conflict, false);
  });

  test("pending create vs a remote delete still loses: delete wins", () => {
    const r = reconcileRemote(pending("expense.create"), { type: "delete" });
    assert.equal(r.applyRemote, true);
    assert.equal(r.keepPending, false);
    assert.equal(r.conflict, false);
  });

  test("no pending op applies the remote", () => {
    const r = reconcileRemote(undefined, { type: "upsert" });
    assert.equal(r.applyRemote, true);
    assert.equal(r.keepPending, false);
    assert.equal(r.conflict, false);
  });
});

describe("sortForPush", () => {
  test("creates before updates before comments, seq preserved within a tier", () => {
    const sorted = sortForPush([
      { kind: "comment.create" as const, seq: 4 },
      { kind: "expense.update" as const, seq: 2 },
      { kind: "expense.create" as const, seq: 3 },
      { kind: "comment.delete" as const, seq: 1 },
      { kind: "payment.create" as const, seq: 0 },
    ]);
    assert.deepEqual(
      sorted.map((op) => `${op.kind}:${op.seq}`),
      [
        "payment.create:0",
        "expense.create:3",
        "expense.update:2",
        "comment.delete:1",
        "comment.create:4",
      ],
    );
  });
});
