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
import { guestRoutes } from "./routes/native/guest.ts";
import { nativeApi } from "./routes/native/v1.ts";
import { startRecurringScheduler } from "./domain/scheduler.ts";
import { compatV3 } from "./routes/compat/v3.ts";
import { compatOpenApiDocument } from "./routes/compat/openapi.ts";

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
// Guest first: a later `/api/v1` mount would otherwise swallow `/api/v1/guest/*`
// and 404 inside nativeApi, which has no guest tree. nativeApi itself has no
// wildcard requireAuth; that stays on each child, so guest auth cannot leak in.
app.route("/api/v1/guest", guestRoutes);
app.route("/api/v1", nativeApi);

// --- Splitwise-compatible API ----------------------------------------------
// Mounted at /api/sw/v3.0, distinct from Splitwise's own base URL
// (https://secure.splitwise.com/api/v3.0) so it's clear this is a compat
// shim, not the real thing. External clients (like splitwise-to-toshl) are
// pointed at this base URL explicitly, so there is no dual mount.
//
// The OpenAPI document is public (it is the frozen wire, not anyone's ledger)
// and lives outside the compat router's requireAuth wildcard.
app.get("/api/sw/v3.0/openapi.json", (c) => c.json(compatOpenApiDocument()));
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
//   everything else  index.html  marketing, about, changelog, docs
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
  // The PWA icon set (`yarn icons`). Under /app/ like the manifest that names
  // them, and registered before the /app/* document fallback for the same reason
  // sw.js is: the fallback would hand back HTML and the install would show a
  // blank icon.
  app.use("/app/icons/*", serveStatic({ root: "./web/dist" }));
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
  // Smoke disables this: seed:demo already ran the job with a pinned clock.
  if (!env.DISABLE_RECURRING_SCHEDULER) {
    startRecurringScheduler().unref();
  }

  serve({ fetch: app.fetch, port: env.PORT }, (info) => {
    console.log(`SplitSmart listening on http://localhost:${info.port}`);
    console.log(`  native API   /api/v1`);
    console.log(`  compat API   /api/sw/v3.0`);
  });
}

export { app };
