/**
 * The change log offline clients pull from.
 *
 * THIS IS THE ONLY MODULE ALLOWED TO WRITE `sync_log`. Every accepted write
 * elsewhere calls in here, in the SAME transaction as the write itself. That is
 * the whole contract: a committed change without a log row is a change no other
 * device will ever learn about, and there is no repair job that could find it
 * later, because "what changed" is exactly the thing the log was supposed to
 * remember.
 *
 * It is NOT the activity feed. `activity` is a human story with suppression
 * rules - the Splitwise importer deliberately writes one entry for a thousand
 * expenses - while this is a replication log where every write appears,
 * imported ones included. Nothing here is shown to a person.
 *
 * WHO MAY READ A ROW IS DECIDED AT READ TIME. `/api/v1/sync/pull` joins the
 * caller's current ACL against this table; there is no per-recipient copy,
 * because fan-out would mean N rows per write and a rewrite of history whenever
 * somebody joined a group. Two questions read-time resolution genuinely cannot
 * answer get columns instead:
 *
 *   `audience_user_id`  "this row is for you and nobody else". You were removed
 *                       from an expense, so you no longer match the participant
 *                       subquery that would have delivered it - the row that
 *                       tells you to drop your copy has to name you.
 *   `other_user_id`     the second half of a pair (a friendship's `user_b_id`,
 *                       a merge's survivor).
 *
 * See docs/OFFLINE.md and the table comment in migrations/001_initial_schema.sql.
 */
import type { DB } from "../db/index.ts";
import { chunkForParams } from "../db/chunk.ts";

export const SYNC_ENTITIES = [
  "expense",
  "comment",
  "group",
  "group_member",
  "friendship",
  "user",
  "user_merge",
] as const;

export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/**
 * `upsert` is everything that leaves a readable row behind, including a restore
 * (the row is live again) and a scheduler tick moving `next_repeat`. `delete` is
 * a ledger tombstone: the row still exists and the client keeps it as one.
 * `forget` is different and stronger - drop your replica, you cannot see this
 * any more - and `merge` is a claim.
 */
export type SyncOp = "upsert" | "delete" | "forget" | "merge";

export interface SyncLogEntry {
  entity: SyncEntity;
  /**
   * The entity's own ULID, except for the composite keys: `group_member` uses
   * the member's user id (with `groupId` set), `friendship` uses `user_a_id`
   * (with `otherUserId` = `user_b_id`), and `user_merge` uses the ghost being
   * consumed (with `otherUserId` = the survivor).
   */
  entityId: string;
  /** Defaults to `upsert`, which is what most writes are. */
  op?: SyncOp;
  /**
   * The group this row belongs to, which is how the pull query resolves group
   * audience. A `comment` copies it from its parent expense so pull never has
   * to join a parent that may itself be deleted.
   */
  groupId?: string | null;
  actorUserId?: string | null;
  otherUserId?: string | null;
  audienceUserId?: string | null;
}

/**
 * Appends one or more rows, inside the caller's transaction.
 *
 * Deliberately NOT best-effort, unlike the system comments in
 * src/domain/comments.ts. A missing footnote costs a sentence; a missing log row
 * costs an expense on every other device, silently and permanently, so a failure
 * here must take the write down with it.
 */
export async function logChange(trx: DB, ...entries: SyncLogEntry[]): Promise<void> {
  if (entries.length === 0) return;

  // Seven columns per row, so one INSERT tops out at 4680 rows before SQLite
  // refuses the statement outright ("too many SQL variables"). Ordinary writes
  // log one or two entries and never come near it; `wipeUserLedger` logs a
  // `forget` per expense, so an account with a few thousand bills made the
  // whole wipe fail with a 500 and no way to reimport. Chunked here rather than
  // at that call site so no future bulk caller has to remember.
  for (const batch of chunkForParams(entries, 7)) {
    await trx
      .insertInto("sync_log")
      .values(
        batch.map((e) => ({
          entity: e.entity,
          entity_id: e.entityId,
          op: e.op ?? "upsert",
          group_id: e.groupId ?? null,
          actor_user_id: e.actorUserId ?? null,
          other_user_id: e.otherUserId ?? null,
          audience_user_id: e.audienceUserId ?? null,
        })),
      )
      .execute();
  }
}

/**
 * Log rows for a change in WHO CAN SEE an expense.
 *
 * An expense upsert reaches its participants and its group's members through the
 * pull query's ordinary clauses. This covers the two cases where that is not
 * enough, and both of them are edits to the audience rather than to the money:
 *
 *   **Lost access.** Someone was a participant and is not any more. They no
 *   longer match the participant subquery, so nothing would ever tell them their
 *   local copy is stale - it would sit in their ledger forever, still counting
 *   towards a balance they are no longer part of. A `forget` addressed to them
 *   is the row that says drop it. Skipped when they are still a current member
 *   of the expense's group, because then they can still see the bill.
 *
 *   **Gained access, no group.** They are a participant now and were not. The
 *   expense itself arrives as the ordinary upsert, but its comments are a
 *   separate entity whose `seq`s are all below the caller's cursor, so the bill
 *   would land with an empty thread. A second upsert row addressed to them is
 *   the marker `/api/v1/sync/pull` turns into `catchUp`. Group expenses need
 *   none of this: comments on them already match the membership clause.
 *
 * A move BETWEEN groups is a lost-access case too, for the old group's members.
 * The expense's log row carries its new `group_id`, so nothing else would ever
 * deliver them the news.
 */
export async function logExpenseAudience(
  trx: DB,
  input: {
    expenseId: string;
    actorId: string;
    /** The group the expense is in after the write. */
    groupId: string | null;
    /** The group it was in before, when that differs. */
    previousGroupId?: string | null;
    /** Participant user ids before the write. */
    before: string[];
    /** Participant user ids after the write. */
    after: string[];
  },
): Promise<void> {
  const after = new Set(input.after);
  const before = new Set(input.before);

  const lost = input.before.filter((id) => !after.has(id));
  const gained = input.after.filter((id) => !before.has(id));

  // Members of a group the expense has just left. They were seeing it through
  // membership, and the new log row does not name their group any more.
  const strandedByMove =
    input.previousGroupId !== undefined &&
    input.previousGroupId !== null &&
    input.previousGroupId !== input.groupId
      ? (
          await trx
            .selectFrom("group_members")
            .select("user_id")
            .where("group_id", "=", input.previousGroupId)
            .where("left_at", "is", null)
            .execute()
        ).map((m) => m.user_id)
      : [];

  const maybeForget = [...new Set([...lost, ...strandedByMove])].filter((id) => !after.has(id));

  // Still in the group the expense is in now? Then they can still see it, and a
  // forget would delete a row they are entitled to.
  const stillMembers =
    input.groupId === null || maybeForget.length === 0
      ? new Set<string>()
      : new Set(
          (
            await trx
              .selectFrom("group_members")
              .select("user_id")
              .where("group_id", "=", input.groupId)
              .where("user_id", "in", maybeForget)
              .where("left_at", "is", null)
              .execute()
          ).map((m) => m.user_id),
        );

  const entries: SyncLogEntry[] = [];

  for (const userId of maybeForget) {
    if (stillMembers.has(userId)) continue;
    entries.push({
      entity: "expense",
      entityId: input.expenseId,
      op: "forget",
      groupId: input.groupId,
      actorUserId: input.actorId,
      audienceUserId: userId,
    });
  }

  if (input.groupId === null) {
    for (const userId of gained) {
      entries.push({
        entity: "expense",
        entityId: input.expenseId,
        op: "upsert",
        groupId: null,
        actorUserId: input.actorId,
        audienceUserId: userId,
      });
    }
  }

  await logChange(trx, ...entries);
}

/**
 * The participant ids currently on an expense.
 *
 * Used either side of an `updateExpense` so the diff above describes what
 * actually landed. Sorted so a caller comparing two of these does not have to.
 */
export async function participantIds(trx: DB, expenseId: string): Promise<string[]> {
  const rows = await trx
    .selectFrom("expense_users")
    .select("user_id")
    .where("expense_id", "=", expenseId)
    .orderBy("user_id")
    .execute();
  return rows.map((r) => r.user_id);
}

/** The highest `seq` written so far, or 0 on an empty log. */
export async function currentSeq(database: DB): Promise<number> {
  const row = await database
    .selectFrom("sync_log")
    .select((eb) => eb.fn.max<number | null>("seq").as("seq"))
    .executeTakeFirst();
  return row?.seq ?? 0;
}
