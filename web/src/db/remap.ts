/**
 * Rewrites a queued expense payload when a ghost is claimed.
 *
 * PURE. No Dexie, no fetch. `applyUserMerge` is the Dexie transaction that
 * calls this; the collision rule is the part that must not drift, and it is
 * testable without a browser (web/src/db/remap.test.ts).
 *
 * Combining two people's paid/owed is `src/domain/merge.ts`'s job. A second
 * implementation in the browser would drift from it, so a payload that would
 * name the survivor twice is `"collision"` rather than a guessed sum - the
 * caller quarantines the outbox entry and the user re-edits.
 */

/**
 * Rewrites `from` to `to` in a queued payload's participant list.
 *
 * Returns the payload unchanged when it never mentioned the ghost, or the string
 * `"collision"` when the rewrite would name the survivor twice. Structural and
 * defensive on purpose: a payload is `unknown` here because the reducer owns its
 * shape, and a payload we cannot read is one we must not silently mangle.
 */
export function remapPayloadUser(
  payload: unknown,
  fromUserId: string,
  toUserId: string,
): unknown | "collision" {
  if (payload === null || typeof payload !== "object") return payload;

  const body = payload as { participants?: Array<{ userId?: unknown }> };
  if (!Array.isArray(body.participants)) return payload;

  const ids = body.participants.map((p) => p.userId);
  if (!ids.includes(fromUserId)) return payload;
  if (ids.includes(toUserId)) return "collision";

  return {
    ...body,
    participants: body.participants.map((p) =>
      p.userId === fromUserId ? { ...p, userId: toUserId } : p,
    ),
  };
}
