/**
 * Day claim: the INSERT is the arbiter, success keeps claim_key, force
 * never owns the day.
 *
 * DATABASE_PATH must be set before importing anything that opens the db.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-backup-claim-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../db/migrate.ts");
const { db } = await import("../db/index.ts");
const {
  claimDay,
  recordSuccess,
  releaseOnFailure,
  releaseStaleClaim,
} = await import("./claim.ts");

before(() => {
  migrate(process.env.DATABASE_PATH!);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("claimDay", () => {
  test("the second claim of the same day stands down", async () => {
    const first = await claimDay("2026-08-14", {
      attempt: 1,
      trigger: "scheduled",
    });
    assert.equal(first.kind, "claimed");
    const second = await claimDay("2026-08-14", {
      attempt: 2,
      trigger: "scheduled",
    });
    assert.equal(second.kind, "already_claimed");
  });

  test("a forced manual run does not own the day", async () => {
    const forced = await claimDay("2026-08-15", {
      attempt: 1,
      trigger: "manual",
      force: true,
    });
    assert.equal(forced.kind, "claimed");
    const scheduled = await claimDay("2026-08-15", {
      attempt: 2,
      trigger: "scheduled",
    });
    assert.equal(scheduled.kind, "claimed");
  });
});

describe("recordSuccess / releaseOnFailure", () => {
  test("success keeps claim_key so a later claim stands down", async () => {
    const claimed = await claimDay("2026-08-16", {
      attempt: 1,
      trigger: "scheduled",
    });
    assert.equal(claimed.kind, "claimed");
    if (claimed.kind !== "claimed") return;

    const recorded = await recordSuccess(claimed.id, {
      isWeekly: false,
      dailyKey: "splitsmart/daily/2026-08-16.sqlite.gz",
      weeklyKey: null,
      sourceBytes: 100,
      snapshotBytes: 90,
      compressedBytes: 40,
      startedAtMs: Date.now() - 10,
    });
    assert.equal(recorded, true);

    const row = await db
      .selectFrom("database_backups")
      .select(["status", "claim_key", "daily_key"])
      .where("id", "=", claimed.id)
      .executeTakeFirst();
    assert.equal(row?.status, "success");
    assert.equal(row?.claim_key, "2026-08-16");
    assert.equal(row?.daily_key, "splitsmart/daily/2026-08-16.sqlite.gz");

    const again = await claimDay("2026-08-16", {
      attempt: 2,
      trigger: "scheduled",
    });
    assert.equal(again.kind, "already_claimed");
  });

  test("failure releases the day so it can be retried", async () => {
    const claimed = await claimDay("2026-08-17", {
      attempt: 1,
      trigger: "scheduled",
    });
    assert.equal(claimed.kind, "claimed");
    if (claimed.kind !== "claimed") return;

    await releaseOnFailure(claimed.id, new Error("disk full"), Date.now() - 5);

    const row = await db
      .selectFrom("database_backups")
      .select(["status", "claim_key", "error_message"])
      .where("id", "=", claimed.id)
      .executeTakeFirst();
    assert.equal(row?.status, "failed");
    assert.equal(row?.claim_key, null);
    assert.match(row?.error_message ?? "", /disk full/);

    const retry = await claimDay("2026-08-17", {
      attempt: 2,
      trigger: "scheduled",
    });
    assert.equal(retry.kind, "claimed");
  });
});

describe("releaseStaleClaim", () => {
  test("abandons a run whose heartbeat has gone quiet", async () => {
    const claimed = await claimDay("2026-08-18", {
      attempt: 1,
      trigger: "scheduled",
    });
    assert.equal(claimed.kind, "claimed");
    if (claimed.kind !== "claimed") return;

    await db
      .updateTable("database_backups")
      .set({
        started_at: "2000-01-01 00:00:00",
        heartbeat_at: "2000-01-01 00:00:00",
      })
      .where("id", "=", claimed.id)
      .execute();

    await releaseStaleClaim("2026-08-18", 15);

    const row = await db
      .selectFrom("database_backups")
      .select(["status", "claim_key"])
      .where("id", "=", claimed.id)
      .executeTakeFirst();
    assert.equal(row?.status, "abandoned");
    assert.equal(row?.claim_key, null);

    const retry = await claimDay("2026-08-18", {
      attempt: 2,
      trigger: "scheduled",
    });
    assert.equal(retry.kind, "claimed");
  });
});
