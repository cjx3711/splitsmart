/**
 * Classification of the two sqlite driver errors the backup day-claim depends
 * on.
 *
 * The distinction is load-bearing: a UNIQUE violation means "another process
 * owns this day, stand down"; SQLITE_BUSY means "unknown, try again next
 * tick". Conflating them either skips a day or runs two concurrent
 * full-database vacuums.
 *
 * better-sqlite3 reports the extended result code when it can
 * (`SQLITE_CONSTRAINT_UNIQUE`); older paths only have `SQLITE_CONSTRAINT`
 * and name the column in the message.
 */

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function errorMessage(err: unknown): string {
  if (typeof err !== "object" || err === null) return "";
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" ? message : "";
}

/**
 * True for a UNIQUE constraint violation.
 *
 * Pass `qualifiedColumn` (e.g. `"database_backups.claim_key"`) to require
 * that this is the specific index you meant, rather than any unique index
 * on the table.
 */
export function isSqliteUniqueViolation(
  err: unknown,
  qualifiedColumn?: string,
): boolean {
  const code = errorCode(err);
  const uniqueCode =
    code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT";
  if (!uniqueCode) return false;
  const message = errorMessage(err);
  if (!message.includes("UNIQUE constraint failed")) return false;
  return qualifiedColumn ? message.includes(qualifiedColumn) : true;
}

/** True when the database was locked and the statement gave up. */
export function isSqliteBusy(err: unknown): boolean {
  const code = errorCode(err);
  return code === "SQLITE_BUSY" || code === "SQLITE_LOCKED";
}
