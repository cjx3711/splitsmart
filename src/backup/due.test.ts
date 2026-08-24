/**
 * Advisory due-check. The INSERT in claim.ts is the arbiter; this file
 * only decides whether a tick should try.
 *
 * DATABASE_PATH must be set before importing anything that opens the db.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BackupSettings } from "./config.ts";

const tempDir = mkdtempSync(join(tmpdir(), "splitsmart-backup-due-"));
process.env.DATABASE_PATH = join(tempDir, "test.db");
process.env.NODE_ENV = "test";
process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-validation";

const { migrate } = await import("../db/migrate.ts");
const { db } = await import("../db/index.ts");
const { claimDay, recordSuccess, releaseOnFailure } = await import("./claim.ts");
const { evaluateDue } = await import("./due.ts");

before(() => {
  migrate(process.env.DATABASE_PATH!);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function settings(overrides: Partial<BackupSettings> = {}): BackupSettings {
  return {
    bucket: "b",
    accessKeyId: "k",
    secretAccessKey: "s",
    endpoint: "https://example.invalid",
    region: "auto",
    forcePathStyle: false,
    keyPrefix: "splitsmart/",
    checksumMode: "when_required",
    hourUtc: 2,
    tickMinutes: 15,
    retentionDays: 7,
    maxAttemptsPerDay: 5,
    retryBackoffMinutes: 60,
    staleAfterMinutes: 15,
    tmpDir: tempDir,
    dbPath: process.env.DATABASE_PATH!,
    ...overrides,
  };
}

describe("evaluateDue", () => {
  test("before the hour with yesterday successful is before_hour", async () => {
    await db
      .insertInto("database_backups")
      .values({
        backup_date: "2026-08-13",
        claim_key: "2026-08-13",
        trigger: "scheduled",
        status: "success",
        attempt: 1,
        is_weekly: 0,
      })
      .execute();

    const decision = await evaluateDue(
      settings(),
      new Date("2026-08-14T01:00:00Z"),
    );
    assert.equal(decision.due, false);
    if (decision.due) return;
    assert.equal(decision.reason, "before_hour");
  });

  test("before the hour with no yesterday success is catch_up", async () => {
    const decision = await evaluateDue(
      settings(),
      new Date("2026-08-20T01:00:00Z"),
    );
    assert.equal(decision.due, true);
    if (!decision.due) return;
    assert.equal(decision.reason, "catch_up");
    assert.equal(decision.backupDate, "2026-08-20");
  });

  test("after the hour is scheduled", async () => {
    const decision = await evaluateDue(
      settings(),
      new Date("2026-08-21T02:00:00Z"),
    );
    assert.equal(decision.due, true);
    if (!decision.due) return;
    assert.equal(decision.reason, "scheduled");
    assert.equal(decision.backupDate, "2026-08-21");
  });

  test("a successful claim makes the day not due", async () => {
    const claimed = await claimDay("2026-08-22", {
      attempt: 1,
      trigger: "scheduled",
    });
    assert.equal(claimed.kind, "claimed");
    if (claimed.kind !== "claimed") return;
    await recordSuccess(claimed.id, {
      isWeekly: false,
      dailyKey: "splitsmart/daily/2026-08-22.sqlite.gz",
      weeklyKey: null,
      sourceBytes: 1,
      snapshotBytes: 1,
      compressedBytes: 1,
      startedAtMs: Date.now(),
    });

    const decision = await evaluateDue(
      settings(),
      new Date("2026-08-22T12:00:00Z"),
    );
    assert.equal(decision.due, false);
    if (decision.due) return;
    assert.equal(decision.reason, "day_claimed");
  });

  test("retry backoff waits after a failure", async () => {
    const claimed = await claimDay("2026-08-23", {
      attempt: 1,
      trigger: "scheduled",
    });
    assert.equal(claimed.kind, "claimed");
    if (claimed.kind !== "claimed") return;
    await releaseOnFailure(claimed.id, new Error("nope"), Date.now());

    const decision = await evaluateDue(
      settings(),
      new Date("2026-08-23T12:00:00Z"),
    );
    assert.equal(decision.due, false);
    if (decision.due) return;
    assert.equal(decision.reason, "retry_backoff");
  });

  test("attempts_exhausted after the daily budget", async () => {
    for (let i = 0; i < 5; i += 1) {
      await db
        .insertInto("database_backups")
        .values({
          backup_date: "2026-08-24",
          claim_key: null,
          trigger: "scheduled",
          status: "failed",
          attempt: i + 1,
          is_weekly: 0,
          started_at: "2026-08-24 00:00:00",
          finished_at: "2026-08-24 00:00:00",
        })
        .execute();
    }

    const decision = await evaluateDue(
      settings({ retryBackoffMinutes: 0 }),
      new Date("2026-08-24T12:00:00Z"),
    );
    assert.equal(decision.due, false);
    if (decision.due) return;
    assert.equal(decision.reason, "attempts_exhausted");
  });
});
