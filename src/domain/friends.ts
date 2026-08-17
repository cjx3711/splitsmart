/**
 * Friendships.
 *
 * Two things live under the word "friend" in this codebase, and keeping them
 * apart matters:
 *
 *   EXPLICIT (a row in `friendships`. Someone you deliberately added. This is
 *              the only kind you can remove.
 *   DERIVED  (someone you share a live group or an expense with. There is no
 *              row for these; joining a group via invite link makes everyone in
 *              it visible immediately, with no extra step.
 *
 * `listRelatedUserIds` returns the union, because that is what every screen and
 * both API trees want to show. `friendships` is stored canonically with
 * user_a_id < user_b_id so a pair can only exist once; go through the helpers
 * here rather than ordering the ids at each call site.
 *
 * The CHECK and these helpers compare ULIDs lexicographically. Crockford
 * strings are a total order, so `<` here is the same comparison SQLite uses.
 */
import { sql } from "kysely";
import type { DB } from "../db/index.ts";
import { transaction } from "../db/index.ts";
import { logChange } from "./sync-log.ts";

/** Canonical column order for the `friendships` primary key. */
export function friendPair(
  userId: string,
  otherUserId: string,
): { userAId: string; userBId: string } {
  if (userId === otherUserId) {
    throw new Error("A user cannot be their own friend");
  }
  return userId < otherUserId
    ? { userAId: userId, userBId: otherUserId }
    : { userAId: otherUserId, userBId: userId };
}

/**
 * Idempotent: adding an existing friendship is a no-op, not an error.
 *
 * Opens its own transaction rather than taking a handle, like the writers in
 * src/domain/expenses.ts and src/domain/comments.ts, because the row and its
 * `sync_log` entry have to land together — a friendship the other devices never
 * hear about is a friend who is missing from the picker on the phone.
 *
 * `actorId` is who did it, which is not always one of the pair: the Splitwise
 * importer adds friendships on its own behalf.
 */
export async function addFriendship(
  userId: string,
  otherUserId: string,
  actorId?: string,
): Promise<void> {
  const { userAId, userBId } = friendPair(userId, otherUserId);

  await transaction(async (trx) => {
    const inserted = await trx
      .insertInto("friendships")
      .values({ user_a_id: userAId, user_b_id: userBId })
      .onConflict((oc) => oc.columns(["user_a_id", "user_b_id"]).doNothing())
      .executeTakeFirst();

    // Nothing changed, so nothing to replicate. Logging an unchanged row would
    // wake every device up to re-apply what it already has.
    if (Number(inserted?.numInsertedOrUpdatedRows ?? 0) === 0) return;

    await logChange(trx, {
      entity: "friendship",
      entityId: userAId,
      otherUserId: userBId,
      op: "upsert",
      actorUserId: actorId ?? userId,
    });
  });
}

/**
 * Drops the explicit friendship.
 *
 * Deliberately does not touch expenses or group membership, so this never moves
 * a balance. Someone you still share a group with stays visible as a DERIVED
 * friend afterwards. See `listRelatedUserIds`.
 *
 * The log row is a `delete`, not a `forget`: the *friendship* is gone, the
 * person is not. They may well still be visible through a shared group or an
 * old expense, and a client that dropped their `users` row would lose the name
 * on every bill they are on.
 */
export async function removeFriendship(
  userId: string,
  otherUserId: string,
  actorId?: string,
): Promise<void> {
  const { userAId, userBId } = friendPair(userId, otherUserId);

  await transaction(async (trx) => {
    const removed = await trx
      .deleteFrom("friendships")
      .where("user_a_id", "=", userAId)
      .where("user_b_id", "=", userBId)
      .executeTakeFirst();

    if (Number(removed?.numDeletedRows ?? 0) === 0) return;

    await logChange(trx, {
      entity: "friendship",
      entityId: userAId,
      otherUserId: userBId,
      op: "delete",
      actorUserId: actorId ?? userId,
    });
  });
}

export async function areFriends(
  db: DB,
  userId: string,
  otherUserId: string,
): Promise<boolean> {
  if (userId === otherUserId) return false;
  const { userAId, userBId } = friendPair(userId, otherUserId);
  const row = await db
    .selectFrom("friendships")
    .select("user_a_id")
    .where("user_a_id", "=", userAId)
    .where("user_b_id", "=", userBId)
    .executeTakeFirst();
  return row !== undefined;
}

/** Just the explicitly-added ones, for distinguishing removable friends. */
export async function listExplicitFriendIds(
  db: DB,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom("friendships")
    .select(["user_a_id", "user_b_id"])
    .where((eb) =>
      eb.or([eb("user_a_id", "=", userId), eb("user_b_id", "=", userId)]),
    )
    .execute();

  return rows.map((r) => (r.user_a_id === userId ? r.user_b_id : r.user_a_id));
}

/**
 * Everyone this user can see: explicit friends, plus everyone they share a live
 * group membership or an expense with.
 *
 * The compat layer's `get_friends` and the native friends list both call this,
 * so the two can never drift apart on who counts as a friend.
 */
export async function listRelatedUserIds(
  db: DB,
  userId: string,
): Promise<string[]> {
  const related = await sql<{ id: string }>`
    SELECT DISTINCT id FROM (
      SELECT CASE WHEN f.user_a_id = ${userId} THEN f.user_b_id ELSE f.user_a_id END AS id
      FROM friendships f
      WHERE f.user_a_id = ${userId} OR f.user_b_id = ${userId}

      UNION

      SELECT gm2.user_id AS id
      FROM group_members gm1
      JOIN group_members gm2 ON gm2.group_id = gm1.group_id
      WHERE gm1.user_id = ${userId} AND gm1.left_at IS NULL AND gm2.left_at IS NULL

      UNION

      SELECT eu2.user_id AS id
      FROM expense_users eu1
      JOIN expense_users eu2 ON eu2.expense_id = eu1.expense_id
      WHERE eu1.user_id = ${userId}
    )
    WHERE id <> ${userId}
  `.execute(db);

  return related.rows.map((r) => r.id);
}
