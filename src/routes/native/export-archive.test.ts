/**
 * Full-account ZIP export at GET /api/v1/export.zip.
 *
 * The filtered spreadsheet is /expenses.csv; this is the Settings download of
 * everything the caller can see, as a ZIP of CSVs.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-export-zip-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../../db/migrate.ts");
const { seed } = await import("../../db/seed.ts");
const { app } = await import("../../server.ts");
const { db } = await import("../../db/index.ts");
const { createApiToken } = await import("../../auth/session.ts");
const { createExpense } = await import("../../domain/expenses.ts");
const { createComment } = await import("../../domain/comments.ts");
const { addFriendship } = await import("../../domain/friends.ts");
const { ulid } = await import("../../domain/ulid.ts");
const { zipFilenames, unzipFile } = await import("../../domain/zip.ts");

let aliceId: string;
let carolId: string;
let groupId: string;
let apiToken: string;

before(async () => {
  migrate(process.env.DATABASE_PATH!);
  seed(process.env.DATABASE_PATH!);

  aliceId = ulid();
  await db
    .insertInto("users")
    .values({
      id: aliceId,
      email: "alice@example.com",
      password_hash: "scrypt$131072$8$1$AAAA$AAAA",
      name: "Alice Anderson",
      nickname: "Alice",
      default_currency: "USD",
      is_ghost: 0,
    })
    .execute();

  carolId = ulid();
  await db
    .insertInto("users")
    .values({
      id: carolId,
      name: "Carol Clark",
      default_currency: "USD",
      is_ghost: 1,
      invite_email: "carol@example.com",
    })
    .execute();

  groupId = ulid();
  await db
    .insertInto("groups")
    .values({
      id: groupId,
      name: "Flat",
      group_type: "home",
      default_currency: "USD",
      created_by: aliceId,
    })
    .execute();

  await db
    .insertInto("group_members")
    .values([
      { group_id: groupId, user_id: aliceId, role: "owner", joined_via: "creator" },
      { group_id: groupId, user_id: carolId, role: "member", joined_via: "added" },
    ])
    .execute();

  await addFriendship(aliceId, carolId, aliceId);

  const expenseId = await createExpense({
    groupId,
    description: "Rent",
    costMinor: 100_000,
    currencyCode: "USD",
    date: "2026-03-01",
    splitType: "equal",
    createdBy: aliceId,
    participants: [
      { userId: aliceId, paidMinor: 100_000 },
      { userId: carolId, paidMinor: 0 },
    ],
  });

  await createComment({
    expenseId,
    userId: aliceId,
    content: "Due on the first",
  });

  apiToken = (await createApiToken(aliceId, "test")).token;
});

after(async () => {
  await db.destroy();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("GET /api/v1/export.zip", () => {
  test("requires auth", async () => {
    const res = await app.request("/api/v1/export.zip");
    assert.equal(res.status, 401);
  });

  test("is a ZIP of CSVs covering the caller's ledger", async () => {
    const res = await app.request("/api/v1/export.zip", {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/zip");
    assert.match(res.headers.get("Content-Disposition") ?? "", /splitsmart-export-.*\.zip/);

    const zip = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual(zipFilenames(zip), [
      "README.txt",
      "account.csv",
      "expenses.csv",
      "comments.csv",
      "groups.csv",
      "people.csv",
    ]);

    const account = unzipFile(zip, "account.csv");
    assert.match(account, /Alice Anderson/);
    assert.match(account, /alice@example.com/);

    const expenses = unzipFile(zip, "expenses.csv");
    assert.match(expenses, /Rent/);
    assert.match(expenses, /1000\.00/);

    const comments = unzipFile(zip, "comments.csv");
    assert.match(comments, /Due on the first/);

    const groups = unzipFile(zip, "groups.csv");
    assert.match(groups, /Flat/);
    assert.match(groups, /Alice/);
    assert.match(groups, /Carol Clark/);

    const people = unzipFile(zip, "people.csv");
    assert.match(people, /Alice Anderson/);
    assert.match(people, /Carol Clark/);
    assert.match(people, /carol@example.com/);
  });
});
