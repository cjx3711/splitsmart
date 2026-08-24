/**
 * The ONLY place `process.env` is read for the backup feature.
 *
 * Parsed once, memoised, and it NEVER THROWS. A bad or partial configuration
 * disables the feature and surfaces named problems; it must never crash boot
 * or break expense traffic.
 *
 * Deliberate rules:
 *  - All-or-nothing. `ready` requires bucket + both credentials + every
 *    optional value parsing cleanly. Never upload with half a config — the
 *    SDK's failure arrives much later and much less legibly.
 *  - Invalid optionals fail the config, they do not fall back.
 *    `BACKUP_HOUR_UTC=25` yields `unconfigured`, because silently backing
 *    up at 00:00 hides the typo.
 *  - No secrets in logs, ever. Access key masked, secret key reported as a
 *    boolean.
 *  - No `AWS_*` names: the SDK's default credential chain would pick up a
 *    half-set pair and fail at request time instead of at parse time, so
 *    credentials are passed explicitly.
 *
 * Kept out of `src/env.ts` on purpose. That module exits the process on a
 * bad value; this one must not. A typo in an S3 endpoint must not take the
 * ledger down.
 */

import path from "node:path";

export type ConfigProblem = {
  key: string;
  reason: "missing" | "invalid";
  hint?: string;
};

export type ChecksumMode = "when_required" | "when_supported";

export type BackupSettings = {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  region: string;
  forcePathStyle: boolean;
  /** Normalised: no leading slash, exactly one trailing slash, or empty. */
  keyPrefix: string;
  checksumMode: ChecksumMode;
  hourUtc: number;
  tickMinutes: number;
  retentionDays: number;
  maxAttemptsPerDay: number;
  retryBackoffMinutes: number;
  staleAfterMinutes: number;
  tmpDir: string;
  dbPath: string;
};

export type BackupConfigState =
  | { status: "ready"; settings: BackupSettings; problems: [] }
  | { status: "disabled" | "unconfigured"; problems: ConfigProblem[] };

export type RedactedBackupConfig = {
  status: "ready" | "disabled" | "unconfigured";
  problems: ConfigProblem[];
  enabled: boolean;
  bucket: string | null;
  endpoint: string | null;
  region: string | null;
  forcePathStyle: string | null;
  keyPrefix: string | null;
  checksumMode: string | null;
  /** Masked to first-4…last-4. Never the full value. */
  accessKeyId: string | null;
  hasSecretAccessKey: boolean;
  hourUtc: string | null;
  tickMinutes: string | null;
  retentionDays: string | null;
  maxAttemptsPerDay: string | null;
  retryBackoffMinutes: string | null;
  staleAfterMinutes: string | null;
  tmpDir: string | null;
  dbPath: string;
};

const DEFAULT_DB_PATH = "./data/splitsmart.db";
const DEFAULT_ENDPOINT = "https://t3.storage.dev";
const DEFAULT_REGION = "auto";
const DEFAULT_PREFIX = "splitsmart/";

/**
 * Single source of truth for which file gets snapshotted. Matches
 * `DATABASE_PATH` in src/env.ts (same default), but reads process.env
 * directly so this module never imports env.ts and cannot crash boot.
 */
export function getDbPath(): string {
  const raw = process.env.DATABASE_PATH;
  return path.resolve(raw && raw.trim() !== "" ? raw.trim() : DEFAULT_DB_PATH);
}

function defaultTmpDir(): string {
  return path.join(path.dirname(getDbPath()), "backups");
}

function rawValue(key: string): string | undefined {
  const value = process.env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? "" : trimmed;
}

/** Treats an empty value as absent — the shape almost every var wants. */
function presentValue(key: string): string | undefined {
  const value = rawValue(key);
  return value === undefined || value === "" ? undefined : value;
}

type Parser<T> = (raw: string) => { ok: true; value: T } | { ok: false; hint: string };

const TRUTHY = new Set(["true", "1", "yes", "on"]);
const FALSY = new Set(["false", "0", "no", "off"]);

const parseBoolean: Parser<boolean> = (raw) => {
  const lowered = raw.toLowerCase();
  if (TRUTHY.has(lowered)) return { ok: true, value: true };
  if (FALSY.has(lowered)) return { ok: true, value: false };
  return { ok: false, hint: "expected true or false" };
};

function parseIntInRange(min: number, max: number): Parser<number> {
  return (raw) => {
    if (!/^-?\d+$/.test(raw)) {
      return { ok: false, hint: `expected an integer between ${min} and ${max}` };
    }
    const value = Number(raw);
    if (value < min || value > max) {
      return { ok: false, hint: `expected an integer between ${min} and ${max}` };
    }
    return { ok: true, value };
  };
}

const parseEndpoint: Parser<string> = (raw) => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, hint: "expected an absolute https:// URL" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, hint: "expected an http:// or https:// URL" };
  }
  return { ok: true, value: raw.replace(/\/+$/, "") };
};

const parseChecksumMode: Parser<ChecksumMode> = (raw) => {
  const lowered = raw.toLowerCase();
  if (lowered === "when_required" || lowered === "when_supported") {
    return { ok: true, value: lowered };
  }
  return { ok: false, hint: "expected when_required or when_supported" };
};

const parseTmpDir: Parser<string> = (raw) => {
  // The snapshot path is interpolated into a `VACUUM INTO '…'` statement,
  // which cannot be parameterised. Reject the characters that would make
  // that unsafe here, where the failure is a legible config problem rather
  // than a mangled SQL string at 00:00 UTC.
  if (/['\n\r\0]/.test(raw)) {
    return { ok: false, hint: "must not contain quotes or newlines" };
  }
  const resolved = path.resolve(raw);
  if (/['\n\r\0]/.test(resolved)) {
    return { ok: false, hint: "must not contain quotes or newlines" };
  }
  return { ok: true, value: resolved };
};

/**
 * Normalise a key prefix: no leading slash, exactly one trailing slash.
 *
 * An explicitly empty value is valid and MUST survive — a bucket dedicated
 * to these backups wants no prefix at all. That is why "unset" and "set to
 * empty" are distinguished rather than collapsed by a `process.env.X ||
 * DEFAULT` fallback, which would silently ignore the operator.
 */
export function normaliseKeyPrefix(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+/, "");
  if (trimmed === "") return "";
  return `${trimmed.replace(/\/+$/, "")}/`;
}

function computeBackupConfig(): BackupConfigState {
  const problems: ConfigProblem[] = [];

  function optional<T>(key: string, fallback: T, parser: Parser<T>): T {
    const raw = presentValue(key);
    if (raw === undefined) return fallback;
    const parsed = parser(raw);
    if (!parsed.ok) {
      problems.push({ key, reason: "invalid", hint: parsed.hint });
      return fallback;
    }
    return parsed.value;
  }

  function required(key: string): string {
    const raw = presentValue(key);
    if (raw === undefined) {
      problems.push({ key, reason: "missing" });
      return "";
    }
    return raw;
  }

  // Parsed before anything else, but the whole config is still walked so
  // that a disabled deployment with a typo elsewhere still reports the
  // typo on the admin page.
  const enabled = optional(
    "BACKUP_ENABLED",
    process.env.NODE_ENV === "production",
    parseBoolean,
  );

  const bucket = required("BACKUP_S3_BUCKET");
  const accessKeyId = required("BACKUP_S3_ACCESS_KEY_ID");
  const secretAccessKey = required("BACKUP_S3_SECRET_ACCESS_KEY");

  const endpoint = optional("BACKUP_S3_ENDPOINT", DEFAULT_ENDPOINT, parseEndpoint);
  const region = optional("BACKUP_S3_REGION", DEFAULT_REGION, (raw) =>
    raw === ""
      ? { ok: false, hint: "must not be empty; the AWS SDK requires a region" }
      : { ok: true, value: raw },
  );
  const forcePathStyle = optional("BACKUP_S3_FORCE_PATH_STYLE", false, parseBoolean);

  // Note `rawValue`, not `presentValue`: BACKUP_S3_PREFIX= means "no prefix".
  const rawPrefix = rawValue("BACKUP_S3_PREFIX");
  const keyPrefix =
    rawPrefix === undefined ? DEFAULT_PREFIX : normaliseKeyPrefix(rawPrefix);

  const checksumMode = optional(
    "BACKUP_S3_CHECKSUM_MODE",
    "when_required" as ChecksumMode,
    parseChecksumMode,
  );

  const hourUtc = optional("BACKUP_HOUR_UTC", 0, parseIntInRange(0, 23));
  const tickMinutes = optional("BACKUP_TICK_MINUTES", 15, parseIntInRange(1, 1440));
  const retentionDays = optional("BACKUP_RETENTION_DAYS", 7, parseIntInRange(1, 3650));
  const maxAttemptsPerDay = optional(
    "BACKUP_MAX_ATTEMPTS_PER_DAY",
    5,
    parseIntInRange(1, 100),
  );
  const retryBackoffMinutes = optional(
    "BACKUP_RETRY_BACKOFF_MINUTES",
    60,
    parseIntInRange(0, 1440),
  );
  const staleAfterMinutes = optional(
    "BACKUP_STALE_AFTER_MINUTES",
    15,
    parseIntInRange(1, 1440),
  );
  const tmpDir = optional("BACKUP_TMP_DIR", defaultTmpDir(), parseTmpDir);

  if (problems.length > 0) {
    return { status: "unconfigured", problems };
  }

  if (!enabled) {
    return { status: "disabled", problems: [] };
  }

  return {
    status: "ready",
    problems: [],
    settings: {
      bucket,
      accessKeyId,
      secretAccessKey,
      endpoint,
      region,
      forcePathStyle,
      keyPrefix,
      checksumMode,
      hourUtc,
      tickMinutes,
      retentionDays,
      maxAttemptsPerDay,
      retryBackoffMinutes,
      staleAfterMinutes,
      tmpDir,
      dbPath: getDbPath(),
    },
  };
}

let cachedConfig: BackupConfigState | null = null;

export function getBackupConfig(): BackupConfigState {
  if (!cachedConfig) {
    cachedConfig = computeBackupConfig();
  }
  return cachedConfig;
}

/** Test seam: forget the memoised value so a changed environment is re-read. */
export function resetBackupConfigCache(): void {
  cachedConfig = null;
}

function maskSecret(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.length <= 8) return `**** (${value.length} chars)`;
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

/**
 * A view of the configuration that is safe to return over HTTP. Built from
 * the raw environment rather than from `settings`, so an `unconfigured`
 * deployment can still show the operator what was parsed — that is usually
 * what identifies the typo.
 */
export function redactBackupConfig(): RedactedBackupConfig {
  const state = getBackupConfig();
  const rawPrefix = rawValue("BACKUP_S3_PREFIX");
  return {
    status: state.status,
    problems: state.problems,
    enabled: state.status === "ready",
    bucket: presentValue("BACKUP_S3_BUCKET") ?? null,
    endpoint: presentValue("BACKUP_S3_ENDPOINT") ?? DEFAULT_ENDPOINT,
    region: presentValue("BACKUP_S3_REGION") ?? DEFAULT_REGION,
    forcePathStyle: presentValue("BACKUP_S3_FORCE_PATH_STYLE") ?? "false",
    keyPrefix:
      rawPrefix === undefined ? DEFAULT_PREFIX : normaliseKeyPrefix(rawPrefix),
    checksumMode: presentValue("BACKUP_S3_CHECKSUM_MODE") ?? "when_required",
    accessKeyId: maskSecret(presentValue("BACKUP_S3_ACCESS_KEY_ID")),
    hasSecretAccessKey: presentValue("BACKUP_S3_SECRET_ACCESS_KEY") !== undefined,
    hourUtc: presentValue("BACKUP_HOUR_UTC") ?? "0",
    tickMinutes: presentValue("BACKUP_TICK_MINUTES") ?? "15",
    retentionDays: presentValue("BACKUP_RETENTION_DAYS") ?? "7",
    maxAttemptsPerDay: presentValue("BACKUP_MAX_ATTEMPTS_PER_DAY") ?? "5",
    retryBackoffMinutes: presentValue("BACKUP_RETRY_BACKOFF_MINUTES") ?? "60",
    staleAfterMinutes: presentValue("BACKUP_STALE_AFTER_MINUTES") ?? "15",
    tmpDir: presentValue("BACKUP_TMP_DIR") ?? defaultTmpDir(),
    dbPath: getDbPath(),
  };
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove credentials from anything about to be persisted or served — error
 * messages in particular, since the AWS SDK happily puts signed URLs and
 * header dumps in them.
 */
export function scrubSecrets(text: string): string {
  let scrubbed = text;
  for (const key of ["BACKUP_S3_SECRET_ACCESS_KEY", "BACKUP_S3_ACCESS_KEY_ID"]) {
    const value = presentValue(key);
    // Very short values would match far too much; they also cannot be real credentials.
    if (value !== undefined && value.length >= 8) {
      scrubbed = scrubbed.replace(
        new RegExp(escapeForRegExp(value), "g"),
        `[redacted:${key}]`,
      );
    }
  }
  scrubbed = scrubbed.replace(
    /(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\s"']+/gi,
    "$1[redacted]",
  );
  return scrubbed;
}

/**
 * One line per process, on scheduler start. Logs the redacted view only —
 * never pass a `logger` to `S3Client`, which prints signed headers.
 */
export function logBackupConfigOnce(): void {
  const globalScope = globalThis as typeof globalThis & {
    __splitsmartBackupConfigLogged__?: boolean;
  };
  if (globalScope.__splitsmartBackupConfigLogged__) return;
  globalScope.__splitsmartBackupConfigLogged__ = true;
  console.log("[backup] config", JSON.stringify(redactBackupConfig()));
}
