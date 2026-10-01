import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-transfer-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";
const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { db, sqlite } = await import("../../db/index.ts");
const { app } = await import("../../server.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense, deleteExpense } = await import("../../domain/expenses.ts");
const { addFriendship, listRelatedUserIds } = await import("../../domain/friends.ts");
const { mintAccessLink } = await import("../../domain/access-links.ts");
const { ulid } = await import("../../domain/ulid.ts");

before(() => { migrate(process.env.DATABASE_PATH!); seed(process.env.DATABASE_PATH!); });
after(() => { sqlite.close(); rmSync(tempDir, { recursive: true, force: true }); });

async function person(name: string, real = false) {
  const id = ulid();
  await db.insertInto("users").values({ id, name, is_ghost: real ? 0 : 1,
    ...(real ? { email: `${id}@example.com`, password_hash: "test" } : {}) }).execute();
  return id;
}
async function group(actor: string, members: string[]) {
  const id = ulid();
  await db.insertInto("groups").values({ id, name: "Trip", created_by: actor }).execute();
  await db.insertInto("group_members").values([actor, ...members].map((user_id) => ({ group_id: id, user_id, role: "member", joined_via: "added" }))).execute();
  return id;
}
async function fixture(realSource = false) {
  const actor = await person("Owner", true), source = await person("Original", realSource), target = await person("Survivor");
  await addFriendship(actor, source); await addFriendship(actor, target);
  const token = (await createApiToken(actor, "test")).token;
  const call = (input: object, preview = false, id = source) => app.request(`/api/v1/friends/${id}/transfer${preview ? "/preview" : ""}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input),
  });
  const move = async (input: object) => {
    const preview = await call(input, true);
    assert.equal(preview.status, 200, await preview.clone().text());
    const body = await preview.json();
    const result = await call({ ...input, confirmed: true, fingerprint: body.fingerprint });
    assert.equal(result.status, 200, await result.clone().text());
    return body;
  };
  const expense = (groupId: string | null = null, both = false, currencyCode = "USD", repeatInterval?: "monthly") => createExpense({
    description: "Dinner", groupId, costMinor: 101, currencyCode, date: "2026-09-01", splitType: "equal", createdBy: actor,
    ...(repeatInterval ? { repeatInterval } : {}),
    participants: [{ userId: actor, paidMinor: 101 }, { userId: source, paidMinor: 0 }, ...(both ? [{ userId: target, paidMinor: 0 }] : [])],
  });
  return { actor, source, target, call, move, expense };
}
const shares = (id: string) => db.selectFrom("expense_users").selectAll().where("expense_id", "=", id).execute();
const record = (id: string) => db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

test("group transfer combines exact shares, keeps both people, and leaves other scopes alone", async () => {
  const f = await fixture();
  const g = await group(f.actor, [f.source, f.target]);
  const other = await group(f.actor, [f.source]);
  const id = await f.expense(g, true), personal = await f.expense(), untouched = await f.expense(other);
  const before = await shares(id);
  const preview = await f.move({ targetId: f.target, mode: "transfer", scope: "group", groupId: g });
  assert.equal(preview.expenseCount, 1); assert.equal(preview.overlappingCount, 1);
  const after = await shares(id);
  assert.equal(after.length, 2);
  assert.equal(after.find((s) => s.user_id === f.actor)!.paid_share_minor, before.find((s) => s.user_id === f.actor)!.paid_share_minor);
  assert.equal(after.find((s) => s.user_id === f.actor)!.owed_share_minor, before.find((s) => s.user_id === f.actor)!.owed_share_minor);
  assert.equal(after.find((s) => s.user_id === f.target)!.owed_share_minor,
    before.filter((s) => s.user_id !== f.actor).reduce((sum, s) => sum + s.owed_share_minor, 0));
  for (const id of [personal, untouched]) assert.ok((await shares(id)).some((s) => s.user_id === f.source));
  assert.equal((await record(f.source)).deleted_at, null);
  assert.ok((await listRelatedUserIds(db, f.actor)).includes(f.source));
});

test("all-scope transfer covers groups, personal, deleted rows, currencies, and recurring templates", async () => {
  const f = await fixture(); const g = await group(f.actor, [f.source]);
  const ids = [await f.expense(g, false, "JPY", "monthly"), await f.expense(), await f.expense(g)];
  await deleteExpense(ids[2]!, f.actor);
  const preview = await f.move({ targetId: f.target, mode: "transfer", scope: "all" });
  assert.equal(preview.expenseCount, 3); assert.equal(preview.deletedCount, 1); assert.equal(preview.groupsToJoin.length, 1);
  for (const id of ids) {
    assert.ok((await shares(id)).some((s) => s.user_id === f.target));
    assert.ok(!(await shares(id)).some((s) => s.user_id === f.source));
  }
  const template = await db.selectFrom("expenses").selectAll().where("id", "=", ids[0]!).executeTakeFirstOrThrow();
  assert.equal(template.repeat_interval, "monthly"); assert.equal(template.currency_code, "JPY");
  assert.equal(template.created_by, f.actor);
  assert.ok(await db.selectFrom("group_members").selectAll().where("group_id", "=", g).where("user_id", "=", f.target).executeTakeFirst());
  assert.equal((await record(f.source)).deleted_at, null);
});

test("personal-only transfer retains a derived friend and emits audience catch-up / forget", async () => {
  const f = await fixture(true); const id = await f.expense();
  await db.deleteFrom("friendships").where((eb) => eb.or([eb("user_a_id", "=", f.source), eb("user_b_id", "=", f.source)])).execute();
  await f.move({ targetId: f.target, mode: "transfer", scope: "personal" });
  assert.ok((await listRelatedUserIds(db, f.actor)).includes(f.source));
  const log = await db.selectFrom("sync_log").selectAll().where("entity_id", "=", id).execute();
  assert.ok(log.some((r) => r.op === "forget" && r.audience_user_id === f.source));
  assert.ok(log.some((r) => r.op === "upsert" && r.audience_user_id === f.target));
});

test("full merge retires a placeholder, transfers memberships and revokes its guest links", async () => {
  const f = await fixture(); const g = await group(f.actor, [f.source]);
  const emptyGroup = await group(f.actor, [f.source]);
  const id = await f.expense(g); await f.expense();
  await mintAccessLink(db, { kind: "friend", userId: f.source, createdBy: f.actor });
  const p = await f.move({ targetId: f.target, mode: "merge", scope: "all" });
  assert.equal(p.groupsToJoin.length, 2);
  assert.equal((await record(f.source)).merged_into_user_id, f.target);
  assert.equal((await record(f.target)).name, "Survivor");
  assert.ok(!(await listRelatedUserIds(db, f.actor)).includes(f.source));
  assert.ok((await shares(id)).some((s) => s.user_id === f.target));
  assert.ok(await db.selectFrom("group_members").selectAll().where("group_id", "=", emptyGroup).where("user_id", "=", f.target).executeTakeFirst());
  const links = await db.selectFrom("access_links").selectAll().where("user_id", "=", f.source).execute();
  assert.ok(links.every((l) => l.revoked_at));
  const log = await db.selectFrom("sync_log").selectAll().where("entity_id", "=", f.source).where("entity", "=", "user_merge").execute();
  assert.ok(log.some((r) => r.audience_user_id === f.actor && r.actor_user_id === f.actor));
});

test("unrelated and private histories cannot be merged or transferred", async () => {
  const f = await fixture(); const stranger = await person("Stranger", true);
  const hidden = await group(stranger, [f.source]);
  const hiddenBill = await createExpense({ groupId: hidden, description: "Private", costMinor: 200, currencyCode: "USD", date: "2026-09-01", splitType: "equal", createdBy: stranger,
    participants: [{ userId: stranger, paidMinor: 200 }, { userId: f.source, paidMinor: 0 }] });
  const personal = await f.expense();
  assert.equal((await f.call({ targetId: f.target, mode: "merge", scope: "all" }, true)).status, 403);
  assert.equal((await f.call({ targetId: f.target, mode: "transfer", scope: "group", groupId: hidden }, true)).status, 404);
  assert.equal((await f.call({ targetId: stranger, mode: "transfer", scope: "all" }, true)).status, 404);
  await f.move({ targetId: f.target, mode: "transfer", scope: "all" });
  assert.ok((await shares(hiddenBill)).some((s) => s.user_id === f.source));
  assert.ok((await shares(personal)).some((s) => s.user_id === f.target));
});

test("registered source cannot be fully merged, and invalid or unconfirmed operations are rejected", async () => {
  const f = await fixture(true); await f.expense();
  assert.equal((await f.call({ targetId: f.target, mode: "merge", scope: "all" }, true)).status, 403);
  assert.equal((await f.call({ targetId: f.source, mode: "transfer", scope: "all" }, true)).status, 400);
  assert.equal((await f.call({ targetId: f.target, mode: "transfer", scope: "group" }, true)).status, 400);
  assert.equal((await f.call({ targetId: f.target, mode: "transfer", scope: "all" })).status, 400);
  assert.equal((await f.call({ targetId: f.target, mode: "transfer", scope: "all" }, true, "bad-id")).status, 400);
});

test("a changed preview fails atomically without moving earlier expenses", async () => {
  const f = await fixture(); const id = await f.expense();
  const input = { targetId: f.target, mode: "transfer", scope: "all" };
  const preview = await (await f.call(input, true)).json();
  await f.expense();
  const result = await f.call({ ...input, confirmed: true, fingerprint: preview.fingerprint });
  assert.equal(result.status, 409);
  assert.ok((await shares(id)).some((s) => s.user_id === f.source));
});

test("a write failure rolls back expenses, new memberships and friendships together", async () => {
  const f = await fixture(); const g = await group(f.actor, [f.source]); const id = await f.expense(g);
  const input = { targetId: f.target, mode: "transfer", scope: "all" };
  const preview = await (await f.call(input, true)).json();
  sqlite.exec("CREATE TRIGGER fail_transfer BEFORE UPDATE ON expense_users BEGIN SELECT RAISE(ABORT, 'forced failure'); END;");
  try { assert.equal((await f.call({ ...input, confirmed: true, fingerprint: preview.fingerprint })).status, 500); }
  finally { sqlite.exec("DROP TRIGGER fail_transfer"); }
  assert.ok((await shares(id)).some((s) => s.user_id === f.source));
  assert.equal(await db.selectFrom("group_members").selectAll().where("group_id", "=", g).where("user_id", "=", f.target).executeTakeFirst(), undefined);
});

test("all ledger invariants still pass after merge and transfer", () => {
  const output = execFileSync(process.execPath, ["--experimental-strip-types", "scripts/check-invariants.ts"], { env: process.env, encoding: "utf8" });
  assert.match(output, /All checks passed/);
});
