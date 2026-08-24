import { test } from "node:test";
import assert from "node:assert/strict";
import { headerSyncView, type HeaderSyncInput } from "./headerSync.ts";

const NOW = Date.parse("2026-08-25T00:05:00.000Z");
const FIVE_MIN_AGO = "2026-08-25T00:00:00.000Z";

function status(partial: Partial<HeaderSyncInput> = {}): HeaderSyncInput {
  return {
    online: true,
    syncing: false,
    pending: 0,
    conflicts: 0,
    rejected: 0,
    lastSyncedAt: FIVE_MIN_AGO,
    lastError: null,
    ...partial,
  };
}

function view(partial: Partial<HeaderSyncInput> = {}, reconnecting = false) {
  return headerSyncView(status(partial), reconnecting, NOW);
}

test("header shows a quiet cloud when everything is on the server", () => {
  assert.deepEqual(view(), {
    kind: "synced",
    label: "Synced",
    count: 0,
    detail: "Last synced 5 minutes ago.",
  });
});

test("header says Saving… while a cycle is in flight with a queue", () => {
  assert.equal(view({ syncing: true, pending: 2 }).kind, "syncing");
  assert.equal(view({ syncing: true, pending: 2 }).label, "Saving…");
});

test("a heartbeat with nothing left to apply looks Synced, not stuck", () => {
  const idle = view({
    syncing: true,
    remaining: 0,
    localCursor: 29117,
    cloudSeq: 29117,
    phase: "pull",
  });
  assert.equal(idle.kind, "synced");
  assert.equal(idle.label, "Synced");
  assert.equal(idle.count, 0);
});

test("a heartbeat that has not reported a gap yet is still Synced", () => {
  assert.equal(view({ syncing: true, phase: "pull" }).kind, "synced");
  assert.equal(view({ syncing: true, phase: "pull" }).label, "Synced");
});

test("header names how many changes are still on the wire", () => {
  const mid = view({ syncing: true, remaining: 1240, phase: "pull" });
  assert.equal(mid.kind, "syncing");
  assert.equal(mid.label, "Syncing… 1,240 left");
  assert.equal(mid.count, 1240);
});

test("a first bootstrap is named as loading a copy, not a vague sync", () => {
  assert.equal(view({ syncing: true, phase: "bootstrap" }).label, "Loading copy…");
});

test("a global seq gap is not shown as work this user still has", () => {
  const mid = view({ syncing: true, localCursor: 10766, cloudSeq: 29117, phase: "hydrate" });
  assert.equal(mid.kind, "syncing");
  assert.equal(mid.label, "Updating…");
  assert.equal(mid.count, 0);
});

test("airplane mode beats a cycle that can no longer reach the server", () => {
  assert.equal(view({ online: false, syncing: true }).kind, "offline");
});

test("a reconnecting tab with a real backlog still shows Syncing…", () => {
  assert.equal(view({ syncing: true, remaining: 12 }, true).kind, "syncing");
});

test("header names unsynced writes while online", () => {
  const one = view({ pending: 1 });
  assert.equal(one.kind, "pending");
  assert.equal(one.label, "1 change not synced");
  assert.equal(one.count, 1);

  assert.equal(view({ pending: 3 }).label, "3 changes not synced");
});

test("offline uses the cloud-off state and keeps the waiting count", () => {
  const idle = view({ online: false });
  assert.equal(idle.kind, "offline");
  assert.equal(idle.label, "Offline");

  const waiting = view({ online: false, pending: 2 });
  assert.equal(waiting.kind, "offline");
  assert.equal(waiting.label, "Offline · 2 changes waiting");
  assert.equal(waiting.count, 2);
});

test("a dropped server that is not a logout looks offline too", () => {
  assert.equal(view({}, true).kind, "offline");
  assert.equal(view({}, true).label, "Offline");
});

test("conflicts outrank syncing and offline", () => {
  const conflict = view({ conflicts: 1, syncing: true, online: false, pending: 4 });
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.label, "1 change not saved");
  assert.equal(conflict.count, 1);

  assert.equal(view({ rejected: 2 }).label, "2 changes not saved");
});

test("an online push error surfaces in the hint, not the label", () => {
  const failed = view({ pending: 1, lastError: "network timeout" });
  assert.equal(failed.kind, "pending");
  assert.equal(failed.label, "1 change not synced");
  assert.equal(failed.detail, "network timeout");
});

test("nothing has synced yet is said plainly", () => {
  assert.equal(view({ lastSyncedAt: null }).detail, "Nothing has synced yet.");
});
