/**
 * Entity metadata: a JSON bag for data that is stored, not queried.
 *
 * Known keys:
 *   splitwise_id - original Splitwise integer, set on import so a second run
 *                  can match instead of duplicating. Never the native PK, never
 *                  on the compat wire.
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
   * Comment-import rule revision. Bumped when previously skipped comments
   * become importable so a later comments step re-fetches those expenses once.
   */
  splitwise_comments_import_rev?: number;
  [key: string]: unknown;
}

/**
 * `expenses.details` on an `import_rounding` settle-up. Friend recency skips
 * these so a leftover-yen payment does not bump a settled friend to the top
 * of the list; the expense itself is dated to the last real bill with them.
 */
export const IMPORT_ROUNDING_DETAILS =
  "Offsets fractional amounts rounded off when importing from Splitwise.";

export function isImportRoundingExpense(expense: {
  details?: string | null;
}): boolean {
  return expense.details === IMPORT_ROUNDING_DETAILS;
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
