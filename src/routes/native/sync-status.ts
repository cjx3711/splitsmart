/**
 * Cheap reads for GET /sync/status.
 *
 * The panel needs more than the global log tip: that number includes writes
 * this caller will never pull, which is why "Latest change 30470 / caught up
 * 30136" can sit next to "This copy is current." Times make that honest.
 *
 *   visible     this caller's latest log row (same audience as pull)
 *   newestId    MAX(id) among expenses / groups / comments they can see
 *   cursor      the log row at this device's seq, when the client sends it
 *
 * `seq` is an integer on purpose (see migrations/001). Entity ids are ULIDs,
 * so newestId is a mint time, not an edit time. `server_ts` on the log row
 * is when the change landed.
 */
import { sql } from "kysely";
import { db } from "../../db/index.ts";

export interface VisibleLogRow {
  seq: number;
  entity_id: string;
  server_ts: string;
}

/**
 * Highest seq this caller would actually pull.
 *
 * Same audience as `pullPage` in sync.ts, but each branch only asks for its
 * own tip. Status polls while the panel is open; scanning the whole visible
 * log every two seconds is how an imported ledger made that dialog hitch.
 */
export async function latestVisibleRow(
  userId: string,
  through?: number,
): Promise<VisibleLogRow | null> {
  const cap =
    through !== undefined && Number.isInteger(through) && through > 0 ? through : null;
  const capSql = cap !== null ? sql`AND seq <= ${cap}` : sql``;

  const rows = await sql<VisibleLogRow>`
    SELECT seq, entity_id, server_ts FROM (
      SELECT seq, entity_id, server_ts FROM (
        SELECT seq, entity_id, server_ts FROM sync_log
        WHERE group_id IN (
          SELECT group_id FROM group_members WHERE user_id = ${userId} AND left_at IS NULL
        )
        ${capSql}
        ORDER BY seq DESC LIMIT 1
      )
      UNION ALL
      SELECT seq, entity_id, server_ts FROM (
        SELECT seq, entity_id, server_ts FROM sync_log
        WHERE entity = 'expense'
          AND entity_id IN (SELECT expense_id FROM expense_users WHERE user_id = ${userId})
        ${capSql}
        ORDER BY seq DESC LIMIT 1
      )
      UNION ALL
      SELECT seq, entity_id, server_ts FROM (
        SELECT seq, entity_id, server_ts FROM sync_log
        WHERE entity = 'comment'
          AND entity_id IN (
            SELECT c.id FROM comments c
            JOIN expense_users eu ON eu.expense_id = c.expense_id
            WHERE eu.user_id = ${userId}
          )
        ${capSql}
        ORDER BY seq DESC LIMIT 1
      )
      UNION ALL
      SELECT seq, entity_id, server_ts FROM (
        SELECT seq, entity_id, server_ts FROM sync_log
        WHERE entity = 'group_member' AND entity_id = ${userId}
        ${capSql}
        ORDER BY seq DESC LIMIT 1
      )
      UNION ALL
      SELECT seq, entity_id, server_ts FROM (
        SELECT seq, entity_id, server_ts FROM sync_log
        WHERE entity = 'friendship'
          AND (entity_id = ${userId} OR other_user_id = ${userId})
        ${capSql}
        ORDER BY seq DESC LIMIT 1
      )
      UNION ALL
      SELECT seq, entity_id, server_ts FROM (
        SELECT seq, entity_id, server_ts FROM sync_log
        WHERE entity = 'user_merge' AND other_user_id = ${userId}
        ${capSql}
        ORDER BY seq DESC LIMIT 1
      )
      UNION ALL
      SELECT seq, entity_id, server_ts FROM (
        SELECT seq, entity_id, server_ts FROM sync_log
        WHERE entity = 'user' AND entity_id = ${userId}
        ${capSql}
        ORDER BY seq DESC LIMIT 1
      )
      UNION ALL
      SELECT seq, entity_id, server_ts FROM (
        SELECT seq, entity_id, server_ts FROM sync_log
        WHERE audience_user_id = ${userId}
        ${capSql}
        ORDER BY seq DESC LIMIT 1
      )
    )
    ORDER BY seq DESC
    LIMIT 1
  `.execute(db);

  return rows.rows[0] ?? null;
}

/**
 * Newest minted entity this caller can see.
 *
 * ULIDs sort by the time encoded in them, so MAX(id) is the most recently
 * created row, not the most recently edited one. The panel compares this to
 * the same MAX on the device.
 */
export async function newestVisibleId(userId: string): Promise<string | null> {
  const rows = await sql<{ id: string | null }>`
    SELECT MAX(id) AS id FROM (
      SELECT e.id FROM expenses e
      INNER JOIN expense_users eu ON eu.expense_id = e.id
      WHERE eu.user_id = ${userId}
      UNION ALL
      SELECT g.id FROM groups g
      INNER JOIN group_members gm ON gm.group_id = g.id
      WHERE gm.user_id = ${userId} AND gm.left_at IS NULL
      UNION ALL
      SELECT c.id FROM comments c
      INNER JOIN expense_users eu ON eu.expense_id = c.expense_id
      WHERE eu.user_id = ${userId}
    )
  `.execute(db);

  return rows.rows[0]?.id ?? null;
}
