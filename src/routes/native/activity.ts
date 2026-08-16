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

export const activityRoutes = new Hono<AppEnv>();
activityRoutes.use("*", requireAuth);

interface ActivityRow {
  id: number;
  action: string;
  payload: string | null;
  created_at: string;
  actor_id: number | null;
  actor_first_name: string | null;
  actor_last_name: string | null;
  group_id: number | null;
  group_name: string | null;
  expense_id: number | null;
  description: string | null;
  cost_minor: number | null;
  currency_code: string | null;
  expense_deleted: string | null;
}

activityRoutes.get("/", async (c) => {
  const auth = c.get("user");
  const limit = Math.min(Number(c.req.query("limit") ?? 50) || 50, 200);
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);

  const rows = await sql<ActivityRow>`
    SELECT a.id, a.action, a.payload, a.created_at,
           actor.id         AS actor_id,
           actor.first_name AS actor_first_name,
           actor.last_name  AS actor_last_name,
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
            firstName: r.actor_first_name ?? "",
            lastName: r.actor_last_name,
          }
        : null,
      group: r.group_id ? { id: r.group_id, name: r.group_name ?? "" } : null,
      expense: r.expense_id
        ? {
            id: r.expense_id,
            description: r.description ?? "",
            costMinor: r.cost_minor ?? 0,
            currencyCode: r.currency_code ?? "",
            // Deleted expenses stay in the feed — "X deleted an expense" is the
            // event people actually want to see.
            deleted: r.expense_deleted !== null,
          }
        : null,
    })),
  });
});
