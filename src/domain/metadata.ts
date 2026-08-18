/**
 * Entity metadata: a JSON bag for data that is stored, not queried.
 *
 * Known keys:
 *   splitwise_id — original Splitwise integer, set on import so a second run
 *                  can match instead of duplicating. Never the native PK, never
 *                  on the compat wire.
 *   notes        — freeform user notes.
 *   repeat_paused — the interval a stopped series had, so Resume can put it
 *                  back without guessing weekly vs monthly. Not a column: the
 *                  CHECK on repeat_interval/next_repeat cannot represent
 *                  "interval set, nothing scheduled".
 *
 * Extra keys are allowed. Do not put anything here that needs an index or a
 * JOIN; those stay as real columns. The unique expression indexes on
 * `$.splitwise_id` are the one exception, because re-import matching needs them.
 */
import { sql, type RawBuilder } from "kysely";

export interface EntityMetadata {
  splitwise_id?: number;
  notes?: string;
  /** Set while a series is stopped; the live interval lives in repeat_interval. */
  repeat_paused?: string;
  [key: string]: unknown;
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

export function splitwiseIdOf(raw: string | null | undefined): number | null {
  const id = parseMetadata(raw).splitwise_id;
  return typeof id === "number" && Number.isInteger(id) ? id : null;
}

export function metadataFromSplitwise(splitwiseId: number): string {
  return serializeMetadata({ splitwise_id: splitwiseId });
}

/** Stamp `splitwise_id` without clobbering notes or other keys. No-op if already set. */
export function metadataWithSplitwiseId(
  existing: string | null | undefined,
  splitwiseId: number,
): string {
  const parsed = parseMetadata(existing);
  if (typeof parsed.splitwise_id === "number") return serializeMetadata(parsed);
  return serializeMetadata({ ...parsed, splitwise_id: splitwiseId });
}

/**
 * `json_extract(table.metadata, '$.splitwise_id')` for WHERE/SELECT.
 * `table` is an identifier we control, never user input.
 */
export function splitwiseIdSql(table?: string): RawBuilder<number | null> {
  const ref = table ? sql.raw(`${table}.metadata`) : sql.raw("metadata");
  return sql<number | null>`json_extract(${ref}, '$.splitwise_id')`;
}
