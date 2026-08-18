/**
 * Hard-delete this account's ledger so a Splitwise import can run on an empty
 * book.
 *
 * THIS IS THE ONE PLACE THAT HARD-DELETES EXPENSE ROWS. Everywhere else is a
 * soft delete through src/domain/expenses.ts, because the compat API surfaces
 * `deleted_at` and undo needs the tombstone. A wipe cannot be a soft delete:
 * `expenses` (and users, groups, comments) carry a unique index on
 * `metadata.splitwise_id`, and a tombstone would still occupy that slot, so
 * the next import would match instead of creating.
 *
 * The account itself stays: email, password, sessions, API tokens, profile.
 * Placeholder people that only exist in this ledger go with it.
 *
 * Shared data with another live real account is a refusal, not a partial
 * delete. Removing Alice's import must not take Bob's balances with it.
 */
import { transaction } from "../db/index.ts";
import { logChange, type SyncLogEntry } from "./sync-log.ts";

/** Must be typed into the second confirmation dialog, and sent on the wire. */
export const WIPE_CONFIRMATION = "DELETE ALL DATA";

export class WipeBlockedError extends Error {
  readonly others: Array<{ id: string; name: string; email: string | null }>;

  constructor(others: Array<{ id: string; name: string; email: string | null }>) {
    const names = others.map((o) => o.name).join(", ");
    super(
      others.length === 1
        ? `Cannot wipe while ${names} still shares groups or expenses with you.`
        : `Cannot wipe while other accounts still share groups or expenses with you: ${names}.`,
    );
    this.name = "WipeBlockedError";
    this.others = others;
  }
}

export interface WipeResult {
  ok: true;
  deleted: {
    expenses: number;
    groups: number;
    friendships: number;
    ghosts: number;
  };
}

export async function wipeUserLedger(userId: string): Promise<WipeResult> {
  return transaction(async (trx) => {
    const memberGroupIds = await ids(
      trx.selectFrom("group_members").select("group_id as id").where("user_id", "=", userId),
    );
    const createdGroupIds = await ids(
      trx.selectFrom("groups").select("id").where("created_by", "=", userId),
    );
    const groupIds = unique([...memberGroupIds, ...createdGroupIds]);

    const participatedExpenseIds = await ids(
      trx.selectFrom("expense_users").select("expense_id as id").where("user_id", "=", userId),
    );
    const createdExpenseIds = await ids(
      trx.selectFrom("expenses").select("id").where("created_by", "=", userId),
    );
    const groupExpenseIds =
      groupIds.length > 0
        ? await ids(trx.selectFrom("expenses").select("id").where("group_id", "in", groupIds))
        : [];
    const expenseIds = unique([...participatedExpenseIds, ...createdExpenseIds, ...groupExpenseIds]);

    const groupMemberIds =
      groupIds.length > 0
        ? await ids(
            trx.selectFrom("group_members").select("user_id as id").where("group_id", "in", groupIds),
          )
        : [];
    const participantIds =
      expenseIds.length > 0
        ? await ids(
            trx
              .selectFrom("expense_users")
              .select("user_id as id")
              .where("expense_id", "in", expenseIds),
          )
        : [];
    const friendIds = unique([
      ...(await ids(
        trx.selectFrom("friendships").select("user_b_id as id").where("user_a_id", "=", userId),
      )),
      ...(await ids(
        trx.selectFrom("friendships").select("user_a_id as id").where("user_b_id", "=", userId),
      )),
    ]);
    const mergedGhostIds = await ids(
      trx.selectFrom("users").select("id").where("merged_into_user_id", "=", userId),
    );

    const relatedUserIds = unique([
      ...groupMemberIds,
      ...participantIds,
      ...friendIds,
      ...mergedGhostIds,
    ]).filter((id) => id !== userId);

    if (relatedUserIds.length > 0) {
      const others = await trx
        .selectFrom("users")
        .select(["id", "name", "email"])
        .where("id", "in", relatedUserIds)
        .where("is_ghost", "=", 0)
        .where("deleted_at", "is", null)
        .execute();
      if (others.length > 0) throw new WipeBlockedError(others);
    }

    const ghostIds =
      relatedUserIds.length > 0
        ? (
            await trx
              .selectFrom("users")
              .select("id")
              .where("id", "in", relatedUserIds)
              .where("is_ghost", "=", 1)
              .execute()
          ).map((r) => r.id)
        : [];

    if (ghostIds.length > 0) {
      const extraReal = await trx
        .selectFrom("group_members")
        .innerJoin("users", "users.id", "group_members.user_id")
        .select(["users.id", "users.name", "users.email"])
        .where("group_members.user_id", "!=", userId)
        .where("users.is_ghost", "=", 0)
        .where("users.deleted_at", "is", null)
        .where("group_members.left_at", "is", null)
        .where((eb) =>
          eb(
            "group_members.group_id",
            "in",
            eb
              .selectFrom("group_members as gm")
              .select("gm.group_id")
              .where("gm.user_id", "in", ghostIds),
          ),
        )
        .execute();
      if (extraReal.length > 0) throw new WipeBlockedError(extraReal);
    }

    const friendships = await trx
      .selectFrom("friendships")
      .select(["user_a_id", "user_b_id"])
      .where((eb) => eb.or([eb("user_a_id", "=", userId), eb("user_b_id", "=", userId)]))
      .execute();

    const logEntries: SyncLogEntry[] = [
      ...expenseIds.map((id) => ({
        entity: "expense" as const,
        entityId: id,
        op: "forget" as const,
        actorUserId: userId,
        audienceUserId: userId,
      })),
      ...friendships.map((row) => ({
        entity: "friendship" as const,
        entityId: row.user_a_id,
        otherUserId: row.user_b_id,
        op: "delete" as const,
        actorUserId: userId,
      })),
    ];
    await logChange(trx, ...logEntries);

    if (expenseIds.length > 0) {
      await trx.deleteFrom("activity").where("expense_id", "in", expenseIds).execute();
    }
    if (groupIds.length > 0) {
      await trx.deleteFrom("activity").where("group_id", "in", groupIds).execute();
    }
    await trx.deleteFrom("activity").where("user_id", "=", userId).execute();
    if (ghostIds.length > 0) {
      await trx.deleteFrom("activity").where("user_id", "in", ghostIds).execute();
    }

    await trx.deleteFrom("access_links").where("created_by", "=", userId).execute();
    if (groupIds.length > 0) {
      await trx.deleteFrom("access_links").where("group_id", "in", groupIds).execute();
    }
    if (ghostIds.length > 0) {
      await trx.deleteFrom("access_links").where("user_id", "in", ghostIds).execute();
    }

    // FKs on the log have no ON DELETE. Null them so groups and ghosts can go.
    if (groupIds.length > 0) {
      await trx.updateTable("sync_log").set({ group_id: null }).where("group_id", "in", groupIds).execute();
    }
    if (ghostIds.length > 0) {
      await trx
        .updateTable("sync_log")
        .set({ other_user_id: null })
        .where("other_user_id", "in", ghostIds)
        .execute();
      await trx
        .updateTable("sync_log")
        .set({ actor_user_id: null })
        .where("actor_user_id", "in", ghostIds)
        .execute();
      await trx
        .updateTable("sync_log")
        .set({ audience_user_id: null })
        .where("audience_user_id", "in", ghostIds)
        .execute();
    }

    if (expenseIds.length > 0) {
      await trx
        .updateTable("expenses")
        .set({ repeat_of: null })
        .where("repeat_of", "in", expenseIds)
        .execute();
      await trx.deleteFrom("expenses").where("id", "in", expenseIds).execute();
    }

    if (groupIds.length > 0) {
      await trx.deleteFrom("groups").where("id", "in", groupIds).execute();
    }

    await trx
      .deleteFrom("friendships")
      .where((eb) => eb.or([eb("user_a_id", "=", userId), eb("user_b_id", "=", userId)]))
      .execute();

    if (ghostIds.length > 0) {
      await trx
        .updateTable("users")
        .set({ merged_into_user_id: null })
        .where("merged_into_user_id", "in", ghostIds)
        .execute();
      await trx
        .updateTable("expenses")
        .set({ created_by: null })
        .where("created_by", "in", ghostIds)
        .execute();
      await trx
        .updateTable("expenses")
        .set({ updated_by: null })
        .where("updated_by", "in", ghostIds)
        .execute();
      await trx
        .updateTable("groups")
        .set({ created_by: null })
        .where("created_by", "in", ghostIds)
        .execute();
      await trx.deleteFrom("users").where("id", "in", ghostIds).execute();
    }

    return {
      ok: true as const,
      deleted: {
        expenses: expenseIds.length,
        groups: groupIds.length,
        friendships: friendships.length,
        ghosts: ghostIds.length,
      },
    };
  });
}

async function ids(query: { execute(): Promise<Array<{ id: string | null }>> }): Promise<string[]> {
  return (await query.execute()).map((r) => r.id).filter((id): id is string => id != null);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
