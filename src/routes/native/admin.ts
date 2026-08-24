/**
 * Operator dashboard API.
 *
 * Usage counts (never ledger contents) and the daily S3 backup panel. Gated
 * by ADMIN_EMAILS via requireAdmin. Mounted at /api/v1/admin (dedicated
 * prefix so it cannot wrap /api/v1/guest/*).
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
import { getAdminBackupsPayload, parseLimit } from "../../backup/admin.ts";
import { redactBackupConfig } from "../../backup/config.ts";
import { triggerBackupNow } from "../../backup/runner.ts";

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
)
  .get(
    "/backups",
    zValidator("query", z.object({ limit: z.string().optional() })),
    async (c) => {
      const payload = await getAdminBackupsPayload(parseLimit(c.req.query("limit")));
      return c.json(payload);
    },
  )
  .post(
    "/backups",
    zValidator("query", z.object({ force: z.string().optional() })),
    async (c) => {
      const force = c.req.query("force") === "true";
      const result = await triggerBackupNow(force);

      switch (result.kind) {
        case "started":
          return c.json(
            {
              run: {
                id: result.id,
                backupDate: result.backupDate,
                attempt: result.attempt,
                trigger: result.trigger,
                status: "running" as const,
              },
            },
            202,
          );
        case "already_running":
          return c.json({ error: "already_running" }, 409);
        case "day_claimed":
          return c.json(
            {
              error: "already_running",
              detail:
                "today is already claimed by another run; use ?force=true to run anyway " +
                "(a forced run is recorded as history and does not own the day)",
            },
            409,
          );
        case "not_configured":
          return c.json(
            { error: "not_configured", config: redactBackupConfig() },
            503,
          );
        case "error":
          return c.json(
            { error: "backup_failed_to_start", detail: result.message },
            500,
          );
      }
    },
  );
