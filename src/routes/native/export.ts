/**
 * CSV export, mounted at /api/v1 rather than under /api/v1/expenses.
 *
 * `/api/v1/expenses.csv` is a SIBLING of `/api/v1/expenses`, not a child, so it
 * cannot live in a router mounted on that path. That URL shape is deliberate:
 * it is what a person guesses, and a browser will download it without any
 * negotiation.
 *
 * Scope is the same as `GET /api/v1/expenses` — expenses the caller is a
 * participant of — with the same filters on top (src/routes/native/
 * expense-filters.ts), so what you see on the All expenses screen is what you get
 * in the file. The guest equivalent lives in guest.ts, scoped to the link.
 *
 * Once the Dexie mirror exists (docs/OFFLINE.md) the same CSV can be built in the
 * browser from local data. This endpoint stays regardless, because it is the one
 * a script can call.
 */
import { Hono } from "hono";
import { db } from "../../db/index.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import { buildExpenseCsv } from "../../domain/expense-csv.ts";
import { expenseFilterWhere, hasFilters, parseExpenseFilters } from "./expense-filters.ts";

/**
 * NO `use("*", requireAuth)` HERE. This router is mounted at `/api/v1`, and a
 * wildcard middleware on it would apply to every path under that prefix —
 * including `/api/v1/guest/*`, whose whole point is that `requireAuth` never
 * touches it. Auth goes on the route itself.
 */
export const exportRoutes = new Hono<AppEnv>();

/**
 * A download is a whole-history request, so there is no paging — but there is a
 * ceiling. 20k rows is a few megabytes of text; past that the honest answer is a
 * narrower date range, not a request that times out halfway through.
 */
const MAX_CSV_ROWS = 20_000;

exportRoutes.get("/expenses.csv", requireAuth, async (c) => {
  const auth = c.get("user");
  const filters = parseExpenseFilters(c.req.query());

  let query = db
    .selectFrom("expenses")
    .innerJoin("expense_users", "expense_users.expense_id", "expenses.id")
    .select("expenses.id")
    .where("expense_users.user_id", "=", auth.id)
    .where("expenses.deleted_at", "is", null)
    .orderBy("expenses.date", "desc")
    .limit(MAX_CSV_ROWS);

  if (hasFilters(filters)) query = query.where(expenseFilterWhere(filters));

  const rows = await query.execute();
  const csv = await buildExpenseCsv(db, rows.map((r) => r.id));

  return csvResponse(c, csv, "splitsmart-expenses.csv");
});

/**
 * Shared response shape, so the guest route cannot end up serving the same bytes
 * with different headers.
 *
 * `text/csv; charset=utf-8` and an explicit filename: without the disposition,
 * browsers render it as a wall of text in a tab.
 */
export function csvResponse(
  c: { body: (data: string, status?: 200, headers?: Record<string, string>) => Response },
  csv: string,
  filename: string,
): Response {
  return c.body(csv, 200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
    // A download is a point-in-time snapshot; caching it would hand back
    // yesterday's ledger on a reload.
    "Cache-Control": "no-store",
  });
}
