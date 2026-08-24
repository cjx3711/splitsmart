/**
 * Whether a live-query snapshot still belongs to the deps of this render.
 *
 * Dexie's `useLiveQuery` keeps serving the previous value until the new querier
 * finishes. Switching friends or groups would otherwise show the new list under
 * the old name. Pure so that rule can be pinned without a browser.
 */
export function queryToken(deps: unknown[]): string {
  return JSON.stringify(deps);
}

export function takeFresh<T>(
  snapshot: { token: string; value: T } | undefined,
  token: string,
): T | undefined {
  if (snapshot === undefined || snapshot.token !== token) return undefined;
  return snapshot.value;
}
