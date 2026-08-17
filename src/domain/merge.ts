/**
 * Merging one person into another.
 *
 * This is what "claim" does: a real account says "that placeholder is me", and
 * the ghost is consumed. The survivor is ALWAYS the logged-in account, because
 * it is the row with a stable session, an email, and a future offline identity.
 *
 * The whole point is that no money moves. Every balance in the app is derived
 * from `expense_repayments`, which is derived from `expense_users`. So the rule
 * for every table below is: repoint the pointer, do not recompute the number.
 * The one place that cannot be a plain repoint is an expense both people are
 * already on, because `expense_users` is keyed `(expense_id, user_id)` and the
 * survivor's row is already sitting on the target key. That case is
 * `mergeExpenseParticipants`, and it ADDS the two rows together rather than
 * re-splitting the bill. See the comment on that function.
 *
 * Everything here runs in ONE transaction. A half-merged user is two people
 * sharing a debt, which is worse than either outcome.
 */
import { sql } from "kysely";
import type { DB } from "../db/index.ts";
import { transaction } from "../db/index.ts";
import { deriveRepayments } from "./split.ts";
import { friendPair } from "./friends.ts";
import { ulid } from "./ulid.ts";

export class MergeError extends Error {}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface MergePreview {
  /** Expenses both people are on. Their shares will be COMBINED. */
  overlapping: Array<{ id: string; description: string; date: string }>;
  /** Expenses only the consumed user is on. They are simply retitled. */
  transferredCount: number;
  /** Groups both are already in; the ghost's membership row is dropped. */
  sharedGroupCount: number;
  /** Live access links pointing at the consumed user; all get revoked. */
  linkCount: number;
}

/**
 * What a merge would do, in the words the confirm dialog needs.
 *
 * Combining two people's shares on one bill is not reversible from the UI, so
 * the user is shown this and asked, rather than having it happen quietly. The
 * overlapping list is capped by the caller when it is long; the count is the
 * part that always matters.
 */
export async function previewMerge(
  db: DB,
  fromUserId: string,
  toUserId: string,
): Promise<MergePreview> {
  if (fromUserId === toUserId) {
    throw new MergeError("Cannot merge a user into themselves");
  }

  const rows = await sql<{
    id: string;
    description: string;
    date: string;
    both: number;
  }>`
    SELECT e.id, e.description, e.date,
           MAX(CASE WHEN eu.user_id = ${toUserId} THEN 1 ELSE 0 END) AS both
    FROM expenses e
    JOIN expense_users eu ON eu.expense_id = e.id
    WHERE e.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM expense_users x
        WHERE x.expense_id = e.id AND x.user_id = ${fromUserId}
      )
    GROUP BY e.id
    ORDER BY e.date DESC
  `.execute(db);

  const overlapping = rows.rows
    .filter((r) => r.both === 1)
    .map((r) => ({ id: r.id, description: r.description, date: r.date }));

  const sharedGroups = await db
    .selectFrom("group_members as a")
    .innerJoin("group_members as b", (join) =>
      join.onRef("b.group_id", "=", "a.group_id").on("b.user_id", "=", toUserId),
    )
    .select("a.group_id")
    .where("a.user_id", "=", fromUserId)
    .execute();

  const links = await db
    .selectFrom("access_links")
    .select("id")
    .where("user_id", "=", fromUserId)
    .where("revoked_at", "is", null)
    .execute();

  return {
    overlapping,
    transferredCount: rows.rows.length - overlapping.length,
    sharedGroupCount: sharedGroups.length,
    linkCount: links.length,
  };
}

// ---------------------------------------------------------------------------
// One expense
// ---------------------------------------------------------------------------

/**
 * Folds one participant into another ON A SINGLE EXPENSE.
 *
 * Also useful on its own: "these two names are the same person on this bill".
 *
 * `expense_users` is keyed `(expense_id, user_id)`, so when the target is
 * already a participant the ghost's row cannot simply be UPDATEd onto their id.
 * The two rows are combined instead:
 *
 *   paid_share_minor  = from.paid  + to.paid
 *   owed_share_minor  = from.owed  + to.owed
 *
 * and the `from` row is dropped. Both column sums are unchanged, so the expense
 * invariant (each must equal `cost_minor`) still holds by construction: the pie
 * is the same, there is one fewer slice.
 *
 * The stored split is then rewritten as `exact` with each remaining person's
 * `split_input` set to what they owe, and `split_meta` cleared. That is
 * deliberate and it is NOT a recomputation:
 *
 *   - Re-running computeSplit for `equal` with one fewer person would move
 *     cents between everybody, which is exactly what a merge must not do.
 *   - `percent` / `shares` / `adjustment` inputs no longer describe the row
 *     set they were entered against.
 *   - `itemized` line items name participant ids that no longer all exist, and
 *     the editor recomputes from those lines, so leaving them would make the
 *     editor disagree with the ledger.
 *
 * Exact-with-cleared-meta is the honest stored form of "these are the numbers".
 * Money does not move; only the description of how it was arrived at changes.
 *
 * Repayments are re-derived, exactly as on every other expense write.
 */
export async function mergeExpenseParticipants(
  trx: DB,
  expenseId: string,
  fromUserId: string,
  toUserId: string,
): Promise<void> {
  if (fromUserId === toUserId) {
    throw new MergeError("Cannot merge a participant into themselves");
  }

  const expense = await trx
    .selectFrom("expenses")
    .select(["id", "cost_minor", "deleted_at"])
    .where("id", "=", expenseId)
    .executeTakeFirst();

  if (!expense) throw new MergeError(`Expense ${expenseId} not found`);

  const shares = await trx
    .selectFrom("expense_users")
    .select(["user_id", "paid_share_minor", "owed_share_minor"])
    .where("expense_id", "=", expenseId)
    .execute();

  const from = shares.find((s) => s.user_id === fromUserId);
  if (!from) return; // not on this expense; nothing to do

  const to = shares.find((s) => s.user_id === toUserId);

  if (!to) {
    // No collision: a plain repoint keeps every number where it was.
    await trx
      .updateTable("expense_users")
      .set({ user_id: toUserId })
      .where("expense_id", "=", expenseId)
      .where("user_id", "=", fromUserId)
      .execute();
  } else {
    await trx
      .updateTable("expense_users")
      .set({
        paid_share_minor: to.paid_share_minor + from.paid_share_minor,
        owed_share_minor: to.owed_share_minor + from.owed_share_minor,
      })
      .where("expense_id", "=", expenseId)
      .where("user_id", "=", toUserId)
      .execute();

    await trx
      .deleteFrom("expense_users")
      .where("expense_id", "=", expenseId)
      .where("user_id", "=", fromUserId)
      .execute();
  }

  const merged = await trx
    .selectFrom("expense_users")
    .select(["user_id", "paid_share_minor", "owed_share_minor"])
    .where("expense_id", "=", expenseId)
    .execute();

  // Stored split becomes a literal statement of the amounts. See the doc block.
  await trx
    .updateTable("expenses")
    .set({ split_type: "exact", split_meta: null })
    .where("id", "=", expenseId)
    .execute();

  for (const share of merged) {
    await trx
      .updateTable("expense_users")
      .set({ split_input: share.owed_share_minor })
      .where("expense_id", "=", expenseId)
      .where("user_id", "=", share.user_id)
      .execute();
  }

  // expense_repayments is a cache of expense_users; rebuild it from scratch,
  // the same way src/domain/expenses.ts does on every write.
  await trx.deleteFrom("expense_repayments").where("expense_id", "=", expenseId).execute();

  const repayments = deriveRepayments(
    merged.map((s) => ({
      userId: s.user_id,
      paidMinor: s.paid_share_minor,
      owedMinor: s.owed_share_minor,
      input: null,
    })),
  );

  if (repayments.length > 0) {
    await trx
      .insertInto("expense_repayments")
      .values(
        repayments.map((r, seq) => ({
          expense_id: expenseId,
          seq,
          from_user_id: r.fromUserId,
          to_user_id: r.toUserId,
          amount_minor: r.amountMinor,
        })),
      )
      .execute();
  }

  await trx
    .updateTable("expenses")
    .set({ created_by: toUserId })
    .where("id", "=", expenseId)
    .where("created_by", "=", fromUserId)
    .execute();

  await trx
    .updateTable("expenses")
    .set({ updated_by: toUserId })
    .where("id", "=", expenseId)
    .where("updated_by", "=", fromUserId)
    .execute();
}

// ---------------------------------------------------------------------------
// The whole person
// ---------------------------------------------------------------------------

export interface MergeResult {
  expensesCombined: number;
  expensesTransferred: number;
  groupsMerged: number;
  linksRevoked: number;
}

/**
 * Consumes `fromUserId` into `toUserId`, in one transaction.
 *
 * The survivor keeps its own name, email and currency: this is "I am that
 * placeholder", not "become that placeholder".
 *
 * `fromUserId` must be a ghost. Merging two real accounts is not a claim, it is
 * an account operation with a login on each side, and this function refuses it
 * rather than guessing which credential wins.
 */
export async function mergeUsers(
  fromUserId: string,
  toUserId: string,
): Promise<MergeResult> {
  if (fromUserId === toUserId) {
    throw new MergeError("Cannot merge a user into themselves");
  }

  return transaction(async (trx) => {
    const [from, to] = await Promise.all([
      trx
        .selectFrom("users")
        .select(["id", "is_ghost", "deleted_at", "merged_into_user_id"])
        .where("id", "=", fromUserId)
        .executeTakeFirst(),
      trx
        .selectFrom("users")
        .select(["id", "is_ghost", "deleted_at"])
        .where("id", "=", toUserId)
        .executeTakeFirst(),
    ]);

    if (!from) throw new MergeError("The person being claimed no longer exists");
    if (!to) throw new MergeError("The account claiming does not exist");
    if (from.deleted_at || from.merged_into_user_id) {
      throw new MergeError("That person has already been claimed");
    }
    if (to.deleted_at) throw new MergeError("The account claiming is deleted");
    if (from.is_ghost !== 1) {
      throw new MergeError("That person already has an account of their own");
    }

    // --- expenses ---------------------------------------------------------
    // Every expense the ghost is on, deleted ones included: a soft-deleted
    // expense still has to point at a live user, and it can be undeleted.
    const expenseIds = (
      await trx
        .selectFrom("expense_users")
        .select("expense_id")
        .where("user_id", "=", fromUserId)
        .execute()
    ).map((r) => r.expense_id);

    const overlapping = new Set(
      (
        await trx
          .selectFrom("expense_users")
          .select("expense_id")
          .where("user_id", "=", toUserId)
          .execute()
      ).map((r) => r.expense_id),
    );

    let combined = 0;
    for (const expenseId of expenseIds) {
      await mergeExpenseParticipants(trx, expenseId, fromUserId, toUserId);
      if (overlapping.has(expenseId)) combined++;
    }

    // Expenses the ghost never participated in but did author or edit.
    await trx
      .updateTable("expenses")
      .set({ created_by: toUserId })
      .where("created_by", "=", fromUserId)
      .execute();
    await trx
      .updateTable("expenses")
      .set({ updated_by: toUserId })
      .where("updated_by", "=", fromUserId)
      .execute();

    // Repayments are rewritten by mergeExpenseParticipants for every expense
    // the ghost was ON. A repayment naming them without a matching share row
    // would be a corrupt cache, so this is a belt-and-braces sweep that also
    // catches self-referencing rows the combine could otherwise leave behind.
    await trx
      .deleteFrom("expense_repayments")
      .where((eb) =>
        eb.or([
          eb("from_user_id", "=", fromUserId),
          eb("to_user_id", "=", fromUserId),
        ]),
      )
      .execute();

    // --- group membership -------------------------------------------------
    const ghostMemberships = await trx
      .selectFrom("group_members")
      .select(["group_id", "role", "joined_via", "joined_at", "left_at"])
      .where("user_id", "=", fromUserId)
      .execute();

    let groupsMerged = 0;
    for (const membership of ghostMemberships) {
      const existing = await trx
        .selectFrom("group_members")
        .select(["role", "left_at"])
        .where("group_id", "=", membership.group_id)
        .where("user_id", "=", toUserId)
        .executeTakeFirst();

      if (!existing) {
        await trx
          .updateTable("group_members")
          .set({ user_id: toUserId })
          .where("group_id", "=", membership.group_id)
          .where("user_id", "=", fromUserId)
          .execute();
        continue;
      }

      // Both are in it. Keep the account's row, but never demote: if either
      // side owned the group, the survivor owns it.
      const role = existing.role === "owner" || membership.role === "owner" ? "owner" : "member";
      // Still in the group if EITHER row is still active. Claiming a
      // placeholder must not resurrect a membership you deliberately left,
      // nor drop you out of a group the placeholder is still in.
      const leftAt = existing.left_at === null || membership.left_at === null
        ? null
        : existing.left_at;

      await trx
        .updateTable("group_members")
        .set({ role, left_at: leftAt })
        .where("group_id", "=", membership.group_id)
        .where("user_id", "=", toUserId)
        .execute();

      await trx
        .deleteFrom("group_members")
        .where("group_id", "=", membership.group_id)
        .where("user_id", "=", fromUserId)
        .execute();

      groupsMerged++;
    }

    // --- friendships ------------------------------------------------------
    // Stored canonically (user_a_id < user_b_id), so a rewrite can collide with
    // an existing pair or become a self-friendship. Both are dropped rather
    // than repaired: "friends with yourself" has no meaning, and a duplicate
    // pair is the same fact twice.
    const ghostFriendships = await trx
      .selectFrom("friendships")
      .select(["user_a_id", "user_b_id"])
      .where((eb) =>
        eb.or([eb("user_a_id", "=", fromUserId), eb("user_b_id", "=", fromUserId)]),
      )
      .execute();

    for (const row of ghostFriendships) {
      const other = row.user_a_id === fromUserId ? row.user_b_id : row.user_a_id;

      await trx
        .deleteFrom("friendships")
        .where("user_a_id", "=", row.user_a_id)
        .where("user_b_id", "=", row.user_b_id)
        .execute();

      // The owner who created the placeholder is very often already a friend
      // of the claiming account, and is always the same person as `other`
      // when they added the ghost themselves. Self-pairs just disappear.
      if (other === toUserId) continue;

      const { userAId, userBId } = friendPair(toUserId, other);
      await trx
        .insertInto("friendships")
        .values({ user_a_id: userAId, user_b_id: userBId })
        .onConflict((oc) => oc.columns(["user_a_id", "user_b_id"]).doNothing())
        .execute();
    }

    // --- comments and the activity feed -----------------------------------
    await trx
      .updateTable("comments")
      .set({ user_id: toUserId })
      .where("user_id", "=", fromUserId)
      .execute();

    await trx
      .updateTable("activity")
      .set({ user_id: toUserId })
      .where("user_id", "=", fromUserId)
      .execute();

    // --- access links -----------------------------------------------------
    // Every link that could act as this ghost dies now. They would stop
    // resolving anyway (the resolver refuses a claimed person), but leaving
    // them "live" in the owner's list would be a lie.
    const revoked = await trx
      .updateTable("access_links")
      .set({ revoked_at: new Date().toISOString() })
      .where("user_id", "=", fromUserId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();

    // --- retire the ghost -------------------------------------------------
    // The row stays so a pointer we missed resolves to a stub instead of
    // dangling, and so support can see what happened. It is not a participant
    // in anything any more.
    await trx
      .updateTable("users")
      .set({
        merged_into_user_id: toUserId,
        deleted_at: new Date().toISOString(),
        // Free the address for the survivor; a claimed placeholder must not
        // keep holding the unique index on an email nobody can log in with.
        email: null,
      })
      .where("id", "=", fromUserId)
      .execute();

    await trx
      .insertInto("activity")
      .values({
        id: ulid(),
        user_id: toUserId,
        action: "user.claimed",
        payload: JSON.stringify({ mergedUserId: fromUserId }),
      })
      .execute();

    return {
      expensesCombined: combined,
      expensesTransferred: expenseIds.length - combined,
      groupsMerged,
      linksRevoked: Number(revoked?.numUpdatedRows ?? 0),
    };
  });
}
