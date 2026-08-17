/**
 * SplitSmart server entry point.
 *
 * One Node process serves three things:
 *   /api/v1/*       native API (clean model, used by the React frontend)
 *   /api/sw/v3.0/*  Splitwise-compatible API (used by external tools)
 *   /*              the built React app (production only; Vite handles dev)
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { readFile } from "node:fs/promises";
import { env } from "./env.ts";
import type { AppEnv } from "./auth/middleware.ts";
import { purgeExpiredSessions } from "./auth/session.ts";
import { purgeExpiredEmailTokens } from "./email/verification.ts";
import { authRoutes } from "./routes/native/auth.ts";
import { claimRoutes } from "./routes/native/claim.ts";
import { linkRoutes } from "./routes/native/links.ts";
import { guestRoutes } from "./routes/native/guest.ts";
import { groupRoutes, expenseRoutes, categoryRoutes } from "./routes/native/groups.ts";
import { friendRoutes } from "./routes/native/friends.ts";
import { activityRoutes } from "./routes/native/activity.ts";
import { importRoutes } from "./routes/native/import.ts";
import { commentRoutes, expenseCommentRoutes } from "./routes/native/comments.ts";
import { exportRoutes } from "./routes/native/export.ts";
import { startRecurringScheduler } from "./domain/scheduler.ts";
import { compatV3 } from "./routes/compat/v3.ts";

const app = new Hono<AppEnv>();

if (env.NODE_ENV !== "test") app.use("*", logger());

app.get("/health", (c) => c.json({ ok: true, version: "0.1.0" }));

// --- Old doors ---------------------------------------------------------------
// `/join/:token` was the group invite link and `/accept/:code` carried a ghost's
// recovery code. Both are gone (docs/GUEST.md, phase 5). These redirects exist
// for one release so a URL already sitting in someone's chat history lands
// somewhere that explains itself: a live secret resolves, and a dead one gets
// "ask whoever shared this for a new link" instead of a bare 404.
app.get("/join/:token", (c) => c.redirect(`/guest/l/${c.req.param("token")}`, 301));
app.get("/accept/:code", (c) => c.redirect(`/guest/l/${c.req.param("code")}`, 301));

// --- Native API -------------------------------------------------------------
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/claim", claimRoutes);
app.route("/api/v1/links", linkRoutes);
app.route("/api/v1/groups", groupRoutes);
app.route("/api/v1/friends", friendRoutes);
app.route("/api/v1/expenses", expenseRoutes);
// A second router on the same prefix, so the comment code stays in one file
// rather than being split across the expense routes it hangs off.
app.route("/api/v1/expenses", expenseCommentRoutes);
app.route("/api/v1/comments", commentRoutes);
app.route("/api/v1/activity", activityRoutes);
app.route("/api/v1/categories", categoryRoutes);
app.route("/api/v1/import", importRoutes);
// `/api/v1/expenses.csv` is a sibling of `/api/v1/expenses`, not a child, so it
// cannot live inside a router mounted on that path.
app.route("/api/v1", exportRoutes);

// --- Guest API ---------------------------------------------------------------
// Its own tree, deliberately. Authentication here is a guest access link and
// NOTHING else; every handler re-checks what that link may see. The routes
// above reject a `link_` bearer outright (src/auth/middleware.ts), so there is
// no path by which a guest secret becomes a full-user credential.
app.route("/api/v1/guest", guestRoutes);

// --- Splitwise-compatible API ----------------------------------------------
// Mounted at /api/sw/v3.0, distinct from Splitwise's own base URL
// (https://secure.splitwise.com/api/v3.0) so it's clear this is a compat
// shim, not the real thing. External clients (like splitwise-to-toshl) are
// pointed at this base URL explicitly, so there is no dual mount.
app.route("/api/sw/v3.0", compatV3);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();

  console.error("Unhandled error:", err);
  // Never leak internals to the client in production.
  const message = env.NODE_ENV === "production" ? "Internal server error" : String(err);
  return c.json({ error: message }, 500);
});

// --- Static frontend (production only) --------------------------------------
//
// Three shells, three documents (docs/GUEST.md, "Two shells"):
//
//   /app, /app/*     app.html    logged-in SPA, PWA scope /app/
//   /guest, /guest/* guest.html  guest SPA, network-only SW scope /guest/
//   everything else  index.html  marketing, about, docs
//
// ORDER MATTERS. serveStatic comes first so /app/sw.js and
// /app/manifest.webmanifest are served as themselves; if the /app/* fallback
// ran first it would hand back an HTML document, the service worker
// registration would fail, and the scope this whole split exists to claim
// would be left to whatever gets registered at /.
if (env.NODE_ENV === "production") {
  app.use("/assets/*", serveStatic({ root: "./web/dist" }));
  app.use("/app/sw.js", serveStatic({ root: "./web/dist" }));
  app.use("/app/manifest.webmanifest", serveStatic({ root: "./web/dist" }));
  app.use("/guest/sw.js", serveStatic({ root: "./web/dist" }));
  app.use("/favicon.svg", serveStatic({ root: "./web/dist" }));
  app.use("/splitsmart.svg", serveStatic({ root: "./web/dist" }));

  const shell = async (c: Context, file: string) => {
    try {
      return c.html(await readFile(`./web/dist/${file}`, "utf8"));
    } catch {
      return c.text("Frontend not built. Run `yarn build:web`.", 503);
    }
  };

  app.get("/app", (c) => shell(c, "app.html"));
  app.get("/app/*", (c) => shell(c, "app.html"));
  app.get("/guest", (c) => shell(c, "guest.html"));
  app.get("/guest/*", (c) => shell(c, "guest.html"));
  app.get("*", (c) => shell(c, "index.html"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Best-effort cleanup on boot and daily thereafter.
  const purge = () => {
    void purgeExpiredSessions().catch(() => {});
    void purgeExpiredEmailTokens().catch(() => {});
  };
  purge();
  setInterval(purge, 86_400_000).unref();

  // Recurring expenses. Only when run as the server: importing this module in a
  // test must never start generating bills. See src/domain/scheduler.ts.
  startRecurringScheduler().unref();

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`SplitSmart listening on http://localhost:${info.port}`);
    console.log(`  native API   /api/v1`);
    console.log(`  compat API   /api/sw/v3.0`);
  });
}

export { app };
