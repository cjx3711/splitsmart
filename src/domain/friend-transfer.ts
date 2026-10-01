/** Authorized, atomic friend merge / scoped expense transfer. */
import { ulid } from "./ulid.ts";
import { createHash } from "node:crypto";
import { sql } from "kysely";
import { transaction, type DB } from "../db/index.ts";
import { friendPair, listRelatedUserIds } from "./friends.ts";
import { mergeExpenseParticipants, mergeUsers } from "./merge.ts";
import { logChange, logExpenseAudience } from "./sync-log.ts";

export interface FriendTransferInput {
  targetId: string;
  mode: "merge" | "transfer";
  scope: "all" | "personal" | "group";
  groupId?: string;
}

export class FriendTransferError extends Error {
  status: 400 | 403 | 404 | 409;
  constructor(message: string, status: 400 | 403 | 404 | 409 = 400) {
    super(message);
    this.status = status;
  }
}

async function plan(database: DB, actorId: string, sourceId: string, input: FriendTransferInput) {
  if (sourceId === input.targetId) throw new FriendTransferError("Choose two different people.");
  if (sourceId === actorId) throw new FriendTransferError("Open a friend's page to transfer their expenses.");
  if (input.mode === "merge" && input.scope !== "all") throw new FriendTransferError("A full merge must include all expenses.");
  if (input.scope === "group" ? !input.groupId : input.groupId !== undefined) {
    throw new FriendTransferError("Choose a group only for a group transfer.");
  }
  const related = await listRelatedUserIds(database, actorId);
  if (!related.includes(sourceId) || (input.targetId !== actorId && !related.includes(input.targetId))) {
    throw new FriendTransferError("Person not found.", 404);
  }
  const people = await database.selectFrom("users").select(["id", "name", "nickname", "is_ghost", "updated_at"])
    .where("id", "in", [sourceId, input.targetId]).where("deleted_at", "is", null).execute();
  const source = people.find((p) => p.id === sourceId);
  const target = people.find((p) => p.id === input.targetId);
  if (!source || !target) throw new FriendTransferError("Person not found.", 404);
  if (input.mode === "merge" && source.is_ghost !== 1) {
    throw new FriendTransferError("A person with their own account cannot be removed by a merge. Choose transfer expenses instead.", 403);
  }
  const memberships = await database.selectFrom("group_members as gm")
    .innerJoin("groups as g", "g.id", "gm.group_id").select(["g.id", "g.name"])
    .where("gm.user_id", "=", actorId).where("gm.left_at", "is", null).where("g.deleted_at", "is", null).execute();
  const allowedGroups = new Set(memberships.map((g) => g.id));
  if (input.scope === "group" && !allowedGroups.has(input.groupId!)) {
    throw new FriendTransferError("Group not found.", 404);
  }
  // Include deleted rows: restoring a bill must not resurrect the old participant.
  const rows = (await sql<{ id: string; group_id: string | null; version: number; deleted_at: string | null; both: number; personal_access: number }>`
    SELECT e.id, e.group_id, e.version, e.deleted_at,
      EXISTS(SELECT 1 FROM expense_users t WHERE t.expense_id = e.id AND t.user_id = ${input.targetId}) AS both,
      EXISTS(SELECT 1 FROM expense_users a WHERE a.expense_id = e.id AND a.user_id = ${actorId}) AS personal_access
    FROM expenses e JOIN expense_users s ON s.expense_id = e.id AND s.user_id = ${sourceId}
    ORDER BY e.id
  `.execute(database)).rows;
  const accessible = (row: { group_id: string | null; personal_access: number }) =>
    row.group_id === null ? row.personal_access === 1 : allowedGroups.has(row.group_id);
  const sourceGroups = await database.selectFrom("group_members").selectAll().where("user_id", "=", sourceId).orderBy("group_id").execute();
  if (input.mode === "merge") {
    // The whole-person writer also rewrites authorship; do not let a shared
    // placeholder provide access to somebody else's private history.
    const authored = (await sql<{ group_id: string | null; personal_access: number }>`
      SELECT e.group_id,
        EXISTS(SELECT 1 FROM expense_users a WHERE a.expense_id = e.id AND a.user_id = ${actorId}) AS personal_access
      FROM expenses e WHERE e.created_by = ${sourceId} OR e.updated_by = ${sourceId}
        OR EXISTS(SELECT 1 FROM comments c WHERE c.expense_id = e.id AND c.user_id = ${sourceId})
    `.execute(database)).rows;
    if (rows.some((r) => !accessible(r)) || authored.some((r) => !accessible(r)) || sourceGroups.some((g) => !allowedGroups.has(g.group_id))) {
      throw new FriendTransferError("This person has history outside your access. Transfer expenses in your groups or personal history instead.", 403);
    }
  }
  const expenses = rows.filter((row) => accessible(row) && (input.scope === "all" ||
    (input.scope === "personal" ? row.group_id === null : row.group_id === input.groupId)));
  const groupIds = new Set(expenses.flatMap((e) => e.group_id ? [e.group_id] : []));
  if (input.mode === "merge") {
    groupIds.clear();
    for (const membership of sourceGroups) {
      if (membership.left_at === null) groupIds.add(membership.group_id);
    }
  }
  const targetGroups = await database.selectFrom("group_members").selectAll().where("user_id", "=", input.targetId).orderBy("group_id").execute();
  const groupsToJoin = memberships.filter((g) => groupIds.has(g.id) && !targetGroups.some((m) => m.group_id === g.id && m.left_at === null));
  const fingerprint = createHash("sha256").update(JSON.stringify({ actorId, sourceId, input, expenses, sourceGroups, targetGroups, people, groupsToJoin })).digest("hex");
  return { source, target, expenses, groupsToJoin, fingerprint };
}

export async function previewFriendTransfer(actorId: string, sourceId: string, input: FriendTransferInput) {
  return transaction(async (trx) => {
    const p = await plan(trx, actorId, sourceId, input);
    return {
      source: p.source, target: p.target, fingerprint: p.fingerprint,
      expenseCount: p.expenses.length,
      overlappingCount: p.expenses.filter((e) => e.both === 1).length,
      deletedCount: p.expenses.filter((e) => e.deleted_at !== null).length,
      groupsToJoin: p.groupsToJoin,
    };
  });
}

export async function executeFriendTransfer(actorId: string, sourceId: string, input: FriendTransferInput, fingerprint: string) {
  if (input.mode === "merge") {
    const result = await mergeUsers(sourceId, input.targetId, {
      actorId,
      validate: async (trx) => {
        const p = await plan(trx, actorId, sourceId, input);
        if (p.fingerprint !== fingerprint) throw new FriendTransferError("The affected history changed. Review the operation again.", 409);
      },
    });
    return { ok: true as const, expenseCount: result.expensesCombined + result.expensesTransferred };
  }
  return transaction(async (trx) => {
    const p = await plan(trx, actorId, sourceId, input);
    if (p.fingerprint !== fingerprint) throw new FriendTransferError("The affected history changed. Review the operation again.", 409);

    for (const group of p.groupsToJoin) {
      await trx.insertInto("group_members").values({ group_id: group.id, user_id: input.targetId, role: "member", joined_via: "added" })
        .onConflict((oc) => oc.columns(["group_id", "user_id"]).doUpdateSet({ left_at: null })).execute();
      await logChange(trx, { entity: "group_member", entityId: input.targetId, groupId: group.id, actorUserId: actorId });
    }
    // Keep even a derived friend visible once their last shared bill moves.
    const { userAId, userBId } = friendPair(actorId, sourceId);
    await trx.insertInto("friendships").values({ user_a_id: userAId, user_b_id: userBId })
      .onConflict((oc) => oc.columns(["user_a_id", "user_b_id"]).doNothing()).execute();
    await logChange(trx, { entity: "friendship", entityId: userAId, otherUserId: userBId, actorUserId: actorId });
    for (const expense of p.expenses) {
      const before = (await trx.selectFrom("expense_users").select("user_id").where("expense_id", "=", expense.id).execute()).map((r) => r.user_id);
      await mergeExpenseParticipants(trx, expense.id, sourceId, input.targetId, { actorId, preserveAuthorship: true });
      await logExpenseAudience(trx, {
        expenseId: expense.id, actorId, groupId: expense.group_id, before,
        after: [...new Set(before.map((id) => id === sourceId ? input.targetId : id))],
      });
    }
    await trx.insertInto("activity").values({
      id: ulid(), user_id: actorId, action: "expenses.transferred",
      payload: JSON.stringify({ sourceId, targetId: input.targetId, scope: input.scope, groupId: input.groupId, expenseCount: p.expenses.length }),
    }).execute();
    return { ok: true as const, expenseCount: p.expenses.length };
  });
}
