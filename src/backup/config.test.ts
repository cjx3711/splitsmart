/**
 * Backup config is all-or-nothing and never throws. These tests drive
 * process.env and the memoisation seam; they must not import the
 * database.
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  getBackupConfig,
  getDbPath,
  normaliseKeyPrefix,
  redactBackupConfig,
  resetBackupConfigCache,
  scrubSecrets,
} from "./config.ts";

const ORIGINAL = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL);
  resetBackupConfigCache();
});

function readyEnv() {
  process.env.BACKUP_ENABLED = "true";
  process.env.BACKUP_S3_BUCKET = "splitsmart-backups";
  process.env.BACKUP_S3_ACCESS_KEY_ID = "tid_abcdefghijklmnop";
  process.env.BACKUP_S3_SECRET_ACCESS_KEY = "tsec_abcdefghijklmnopqrstuvwxyz";
}

describe("getBackupConfig", () => {
  test("missing credentials is unconfigured, not a throw", () => {
    delete process.env.BACKUP_S3_BUCKET;
    delete process.env.BACKUP_S3_ACCESS_KEY_ID;
    delete process.env.BACKUP_S3_SECRET_ACCESS_KEY;
    resetBackupConfigCache();
    const state = getBackupConfig();
    assert.equal(state.status, "unconfigured");
    if (state.status !== "unconfigured") return;
    assert.ok(state.problems.some((p) => p.key === "BACKUP_S3_BUCKET" && p.reason === "missing"));
  });

  test("invalid optionals fail the whole config rather than falling back", () => {
    readyEnv();
    process.env.BACKUP_HOUR_UTC = "25";
    resetBackupConfigCache();
    const state = getBackupConfig();
    assert.equal(state.status, "unconfigured");
    if (state.status !== "unconfigured") return;
    assert.ok(
      state.problems.some(
        (p) => p.key === "BACKUP_HOUR_UTC" && p.reason === "invalid",
      ),
    );
  });

  test("credentials present but BACKUP_ENABLED=false is disabled", () => {
    readyEnv();
    process.env.BACKUP_ENABLED = "false";
    resetBackupConfigCache();
    const state = getBackupConfig();
    assert.equal(state.status, "disabled");
  });

  test("a complete config is ready", () => {
    readyEnv();
    resetBackupConfigCache();
    const state = getBackupConfig();
    assert.equal(state.status, "ready");
    if (state.status !== "ready") return;
    assert.equal(state.settings.bucket, "splitsmart-backups");
    assert.equal(state.settings.keyPrefix, "splitsmart/");
    assert.equal(state.settings.hourUtc, 0);
    assert.equal(state.settings.dbPath, getDbPath());
  });
});

describe("redactBackupConfig", () => {
  test("masks the access key and never returns the secret", () => {
    readyEnv();
    resetBackupConfigCache();
    const redacted = redactBackupConfig();
    assert.equal(redacted.accessKeyId, "tid_…mnop");
    assert.equal(redacted.hasSecretAccessKey, true);
    assert.equal(
      JSON.stringify(redacted).includes("tsec_abcdefghijklmnopqrstuvwxyz"),
      false,
    );
  });
});

describe("scrubSecrets", () => {
  test("strips credentials and presigned-URL parameters", () => {
    readyEnv();
    resetBackupConfigCache();
    const raw =
      "failed with tsec_abcdefghijklmnopqrstuvwxyz and X-Amz-Signature=deadbeef&ok=1";
    const scrubbed = scrubSecrets(raw);
    assert.equal(scrubbed.includes("tsec_abcdefghijklmnopqrstuvwxyz"), false);
    assert.match(scrubbed, /X-Amz-Signature=\[redacted\]/);
  });
});

describe("normaliseKeyPrefix", () => {
  test("keeps an explicit empty prefix empty", () => {
    assert.equal(normaliseKeyPrefix(""), "");
  });
});
