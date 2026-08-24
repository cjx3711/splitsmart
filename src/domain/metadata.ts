/**
 * Entity metadata: a JSON bag for data that is stored, not queried.
 *
 * Known keys:
 *   splitwise_id - original Splitwise integer, set on import so a second run
 *                  can match instead of duplicating. Never the native PK.
 *   splitwise_registration_status - Splitwise's `registration_status` on the
 *                  person, stored so signup can tell a real Splitwise account
 *                  (`confirmed`) from an email-only dummy. See
 *                  src/domain/splitwise-identity.ts.
 *   notes        - freeform user notes.
 *   repeat_paused - the interval a stopped series had, so Resume can put it
 *                  back without guessing weekly vs monthly. Not a column: the
 *                  CHECK on repeat_interval/next_repeat cannot represent
 *                  "interval set, nothing scheduled".
 *
 * Extra keys are allowed. Do not put anything here that needs an index or a
 * JOIN; those stay as real columns. The unique expression indexes on
 * `$.splitwise_id` are the one exception, because re-import matching needs them.
 * The comments step also filters on `$.splitwise_comments_count` (pending
 * work); that is a one-shot import walk, not a hot path, and is not indexed.
 */
import { sql, type RawBuilder } from "kysely";
import { isRepeatInterval, type RepeatInterval } from "./recurring.ts";

export interface EntityMetadata {
  splitwise_id?: number;
  /**
   * Splitwise `registration_status`, lowercased. `confirmed` is a real
   * Splitwise account; `dummy` is an email someone else typed.
   */
  splitwise_registration_status?: string;
  notes?: string;
  /** Set while a series is stopped; the live interval lives in repeat_interval. */
  repeat_paused?: string;
  /**
   * A one-on-one settle-up that restores a Splitwise friend total after import
   * dropped extra digits past the currency's scale. Not a Splitwise row.
   */
  import_rounding?: boolean;
  /**
   * Pending Splitwise comment fetch. Stamped from `comments_count` when the
   * expense list did not nest `comments[]`. Cleared once `get_comments` has
   * run (or nested comments were imported), so a second comments step is a
   * no-op. Presence with a value > 0 is the work queue; absence means done
   * or never needed.
   */
  splitwise_comments_count?: number;
  /**
   * Legacy completion stamp from an older comments importer. Still recognised
   * so those rows are not re-fetched; new runs clear it alongside the count.
   */
  splitwise_comments_synced_at?: string;
  /** Legacy comments-import rule revision. No longer written. */
  splitwise_comments_import_rev?: number;
  [key: string]: unknown;
}

/**
 * Legacy `expenses.details` on an `import_rounding` settle-up. New rounding
 * payments leave details empty: the system comment is the user-visible
 * explanation, and `metadata.import_rounding` (mirrored as `importRounding` on
 * the sync document) is what friend recency skips. Kept so already-imported
 * rows still drop out of recency and stay hidden on the expense page.
 */
export const IMPORT_ROUNDING_DETAILS =
  "Offsets fractional amounts rounded off when importing from Splitwise.";

export function isImportRoundingExpense(expense: {
  details?: string | null;
  importRounding?: boolean;
}): boolean {
  return expense.importRounding === true || expense.details === IMPORT_ROUNDING_DETAILS;
}

export function importRoundingOf(raw: string | null | undefined): boolean {
  return parseMetadata(raw).import_rounding === true;
}

export const EMPTY_METADATA = "{}";

export function parseMetadata(raw: string | null | undefined): EntityMetadata {
  if (raw == null || raw === "") return {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value == null || typeof value !== "object" || Array.isArray(value)) return {};
    return value as EntityMetadata;
  } catch {
    return {};
  }
}

export function serializeMetadata(meta: EntityMetadata): string {
  return JSON.stringify(meta);
}

/** The interval a stopped series will resume with, or null if it is not paused. */
export function repeatPausedOf(raw: string | null | undefined): RepeatInterval | null {
  const value = parseMetadata(raw).repeat_paused;
  return isRepeatInterval(value) ? value : null;
}

export function splitwiseIdOf(raw: string | null | undefined): number | null {
  const id = parseMetadata(raw).splitwise_id;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

export function metadataFromSplitwise(
  splitwiseId: number,
  registrationStatus?: string | null,
): string {
  return metadataWithSplitwiseIdentity("{}", splitwiseId, registrationStatus);
}

/** Stamp `splitwise_id` without clobbering notes or other keys. No-op if already set. */
export function metadataWithSplitwiseId(
  existing: string | null | undefined,
  splitwiseId: number,
): string {
  return metadataWithSplitwiseIdentity(existing, splitwiseId);
}

/**
 * Stamp Splitwise identity. The id is write-once; a missing registration
 * status can be filled in later when an import sees the person again.
 */
export function metadataWithSplitwiseIdentity(
  existing: string | null | undefined,
  splitwiseId: number,
  registrationStatus?: string | null,
): string {
  const parsed = parseMetadata(existing);
  if (typeof parsed.splitwise_id !== "number") parsed.splitwise_id = splitwiseId;
  const status = normalizeSplitwiseRegistrationStatus(registrationStatus);
  const current = parsed.splitwise_registration_status;
  if (status && current !== status) {
    // Fill in, or upgrade dummy → confirmed. Never demote a confirmed person.
    if (!current || (current === "dummy" && status === "confirmed")) {
      parsed.splitwise_registration_status = status;
    }
  }
  return serializeMetadata(parsed);
}

export function normalizeSplitwiseRegistrationStatus(
  status: string | null | undefined,
): string | undefined {
  if (typeof status !== "string") return undefined;
  const trimmed = status.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function splitwiseRegistrationStatusOf(
  raw: string | null | undefined,
): "confirmed" | "dummy" | null {
  const parsed = parseMetadata(raw).splitwise_registration_status;
  const value = normalizeSplitwiseRegistrationStatus(
    typeof parsed === "string" ? parsed : undefined,
  );
  if (value === "confirmed" || value === "dummy") return value;
  return null;
}

/**
 * `json_extract(table.metadata, '$.splitwise_id')` for WHERE/SELECT.
 * `table` is an identifier we control, never user input.
 */
export function splitwiseIdSql(table?: string): RawBuilder<number | null> {
  const ref = table ? sql.raw(`${table}.metadata`) : sql.raw("metadata");
  return sql<number | null>`json_extract(${ref}, '$.splitwise_id')`;
}

/**
 * Pending comment-import count. Queried by the comments step so expenses
 * Splitwise said have no comments are never a `get_comments` round trip.
 * Not indexed: import is a one-shot walk, not a hot path.
 */
export function splitwiseCommentsCountSql(table?: string): RawBuilder<number | null> {
  const ref = table ? sql.raw(`${table}.metadata`) : sql.raw("metadata");
  return sql<number | null>`json_extract(${ref}, '$.splitwise_comments_count')`;
}

export function splitwiseCommentsSyncedAtSql(table?: string): RawBuilder<string | null> {
  const ref = table ? sql.raw(`${table}.metadata`) : sql.raw("metadata");
  return sql<string | null>`json_extract(${ref}, '$.splitwise_comments_synced_at')`;
}
