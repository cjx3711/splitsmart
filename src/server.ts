/**
 * SplitSmart server entry point.
 *
 * One Node process serves three things:
 *   /api/v1/*    — native API (clean model, used by the React frontend)
 *   /api/v3.0/*  — Splitwise-compatible API (used by external tools)
 *   /*           — the built React app (production only; Vite handles dev)
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { readFile } from "node:fs/promises";
import { env } from "./env.ts";
import type { AppEnv } from "./auth/middleware.ts";
import { purgeExpiredSessions } from "./auth/session.ts";
import { purgeExpiredEmailTokens } from "./email/verification.ts";
import { authRoutes } from "./routes/native/auth.ts";
import { inviteRoutes } from "./routes/native/invite.ts";
import { groupRoutes, expenseRoutes, categoryRoutes } from "./routes/native/groups.ts";
import { compatV3 } from "./routes/compat/v3.ts";

const app = new Hono<AppEnv>();

if (env.NODE_ENV !== "test") app.use("*", logger());

app.get("/health", (c) => c.json({ ok: true, version: "0.1.0" }));

// --- Native API -------------------------------------------------------------
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/invite", inviteRoutes);
app.route("/api/v1/groups", groupRoutes);
app.route("/api/v1/expenses", expenseRoutes);
app.route("/api/v1/categories", categoryRoutes);

// --- Splitwise-compatible API ----------------------------------------------
// Mounted at BOTH paths on purpose: Splitwise's real base URL is
// https://secure.splitwise.com/api/v3.0, and clients that proxy (like
// splitwise-to-toshl) may or may not preserve the /api prefix.
app.route("/api/v3.0", compatV3);
app.route("/v3.0", compatV3);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();

  console.error("Unhandled error:", err);
  // Never leak internals to the client in production.
  const message = env.NODE_ENV === "production" ? "Internal server error" : String(err);
  return c.json({ error: message }, 500);
});

// --- Static frontend (production only) --------------------------------------
if (env.NODE_ENV === "production") {
  app.use("/assets/*", serveStatic({ root: "./web/dist" }));
  app.get("*", async (c) => {
    try {
      const html = await readFile("./web/dist/index.html", "utf8");
      return c.html(html);
    } catch {
      return c.text("Frontend not built. Run `npm run build:web`.", 503);
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Best-effort cleanup on boot and daily thereafter.
  const purge = () => {
    void purgeExpiredSessions().catch(() => {});
    void purgeExpiredEmailTokens().catch(() => {});
  };
  purge();
  setInterval(purge, 86_400_000).unref();

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`SplitSmart listening on http://localhost:${info.port}`);
    console.log(`  native API   /api/v1`);
    console.log(`  compat API   /api/v3.0`);
  });
}

export { app };
