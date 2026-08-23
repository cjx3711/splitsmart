/**
 * Splitting bulk statements so they stay under SQLite's bind-variable ceiling.
 *
 * SQLite compiles `?` placeholders into a fixed-size array, and refuses past
 * SQLITE_MAX_VARIABLE_NUMBER with "too many SQL variables". Since 3.32 that
 * default is 32766. It is a limit on the *statement*, not on the data, so it
 * shows up only once a real account is big enough - which is the worst way for
 * a limit to show up, because every test fixture is small enough to pass.
 *
 * Two shapes hit it:
 *
 *   - a multi-row INSERT, which spends (rows x columns) variables. This is the
 *     sharper edge: at 7 columns the ceiling is 4680 ROWS, not 32766.
 *   - `where("id", "in", ids)`, which spends one per id.
 *
 * Anywhere a list is bounded by "how much history does this account have"
 * rather than by a page size, it must go through here.
 */

/** SQLITE_MAX_VARIABLE_NUMBER, the default since SQLite 3.32. */
export const SQLITE_MAX_VARIABLES = 32766;

/**
 * Splits `items` so each chunk spends at most `SQLITE_MAX_VARIABLES` bind
 * variables, given that each item costs `paramsPerItem` of them.
 *
 * The headroom divisor is deliberate: a statement is rarely *only* the bulk
 * part (an INSERT ... ON CONFLICT, or an `in` list next to other predicates),
 * and being a little under the ceiling costs one extra round trip while being
 * a little over throws.
 */
export function chunkForParams<T>(items: readonly T[], paramsPerItem: number): T[][] {
  if (paramsPerItem < 1) throw new Error("paramsPerItem must be at least 1");
  const perChunk = Math.max(1, Math.floor((SQLITE_MAX_VARIABLES - 64) / paramsPerItem));
  if (items.length <= perChunk) return items.length === 0 ? [] : [[...items]];

  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += perChunk) {
    chunks.push(items.slice(i, i + perChunk));
  }
  return chunks;
}

/** Chunks an id list for a `where(..., "in", ids)`: one variable per id. */
export function chunkIds(ids: readonly string[]): string[][] {
  return chunkForParams(ids, 1);
}

/**
 * Runs a write once per chunk.
 *
 * Safe for DELETE and UPDATE keyed on an id list: the chunks are disjoint, so
 * every row is matched by exactly one of them and the result is the same as
 * the single statement would have been.
 */
export async function forEachIdChunk(
  ids: readonly string[],
  run: (chunk: string[]) => Promise<unknown>,
): Promise<void> {
  for (const chunk of chunkIds(ids)) await run(chunk);
}

/** Runs a read once per chunk and concatenates the rows. */
export async function collectIdChunks<R>(
  ids: readonly string[],
  run: (chunk: string[]) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (const chunk of chunkIds(ids)) out.push(...(await run(chunk)));
  return out;
}
