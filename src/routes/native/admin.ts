/**
 * Operator usage dashboard API.
 *
 * Counts and a 30-day activity series only — never ledger contents. Gated by
 * ADMIN_EMAILS via requireAdmin. Mounted at /api/v1/admin (dedicated prefix so
 * it cannot wrap /api/v1/guest/*).
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { AppEnv } from "../../auth/middleware.ts";
import { requireAuth, requireAdmin } from "../../auth/middleware.ts";
import {
  getAdminUser,
  listAdminUsers,
  parseAsOf,
} from "../../domain/admin-stats.ts";

export const adminRoutes = new Hono<AppEnv>()
  .use("*", requireAuth, requireAdmin)
  .get(
    "/users",
    zValidator(
      "query",
      z.object({ q: z.string().optional(), as_of: z.string().optional() }),
    ),
    async (c) => {
  const asOf = parseAsOf(c.req.query("as_of"));
  const q = c.req.query("q");
  const users = await listAdminUsers(q, asOf);
  return c.json({ asOf, users });
},
)
  .get(
    "/users/:id",
    zValidator("query", z.object({ as_of: z.string().optional() })),
    async (c) => {
  const asOf = parseAsOf(c.req.query("as_of"));
  const user = await getAdminUser(c.req.param("id"), asOf);
  if (!user) return c.json({ error: "Not found" }, 404);
  return c.json({ asOf, user });
},
);
