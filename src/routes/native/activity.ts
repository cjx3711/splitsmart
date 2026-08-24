/**
 * The activity feed.
 *
 * `activity` is append-only and written by src/domain/expenses.ts on every
 * expense write. This is the read side, which until now did not exist.
 *
 * Scope rule: you see an event if it happened in a group you are in, or on an
 * expense you are a participant of. That second clause is what makes one-on-one
 * expenses show up at all, since they belong to no group.
 */
import { Hono } from "hono";
import { sql } from "kysely";
import { db } from "../../db/index.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import { parseAvatarPattern } from "../../domain/avatar-pattern.ts";

interface ActivityRow {
  id: string;
  action: string;
  payload: string | null;
  created_at: string;
  actor_id: string | null;
  actor_name: string | null;
  actor_nickname: string | null;
  actor_icon_letters: string | null;
  actor_icon_emoji: string | null;
  actor_icon_hue: number | null;
  actor_icon_pattern: string | null;
  group_id: string | null;
  group_name: string | null;
  expense_id: string | null;
  description: string | null;
  cost_minor: number | null;
  currency_code: string | null;
  expense_deleted: string | null;
}

export const activityRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/", async (c) => {
  const auth = c.get("user");
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);

  const rows = await sql<ActivityRow>`
    SELECT a.id, a.action, a.payload, a.created_at,
           actor.id         AS actor_id,
           actor.name       AS actor_name,
           actor.nickname   AS actor_nickname,
           actor.icon_letters AS actor_icon_letters,
           actor.icon_emoji AS actor_icon_emoji,
           actor.icon_hue   AS actor_icon_hue,
           actor.icon_pattern AS actor_icon_pattern,
           a.group_id,
           g.name           AS group_name,
           a.expense_id,
           e.description,
           e.cost_minor,
           e.currency_code,
           e.deleted_at     AS expense_deleted
    FROM activity a
    LEFT JOIN users  actor ON actor.id = a.user_id
    LEFT JOIN groups g     ON g.id = a.group_id
    LEFT JOIN expenses e   ON e.id = a.expense_id
    WHERE
      EXISTS (
        SELECT 1 FROM group_members gm
        WHERE gm.group_id = a.group_id AND gm.user_id = ${auth.id} AND gm.left_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM expense_users eu
        WHERE eu.expense_id = a.expense_id AND eu.user_id = ${auth.id}
      )
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `.execute(db);

  return c.json({
    activity: rows.rows.map((r) => ({
      id: r.id,
      action: r.action,
      createdAt: r.created_at,
      actor: r.actor_id
        ? {
            id: r.actor_id,
            name: r.actor_name ?? "",
            nickname: r.actor_nickname,
            iconLetters: r.actor_icon_letters,
            iconEmoji: r.actor_icon_emoji,
            iconHue: r.actor_icon_hue,
            iconPattern: parseAvatarPattern(r.actor_icon_pattern),
          }
        : null,
      group: r.group_id ? { id: r.group_id, name: r.group_name ?? "" } : null,
      expense: r.expense_id
        ? {
            id: r.expense_id,
            description: r.description ?? "",
            costMinor: r.cost_minor ?? 0,
            currencyCode: r.currency_code ?? "",
            // Deleted expenses stay in the feed; "X deleted an expense" is the
            // event people actually want to see.
            deleted: r.expense_deleted !== null,
          }
        : null,
    })),
  });
});
