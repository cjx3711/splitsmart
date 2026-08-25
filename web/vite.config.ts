import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAppOrigin } from "../src/open-graph.ts";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Three shells, three HTML entry points. See docs/GUEST.md, "Two shells".
 *
 *   /          marketing, about, changelog, docs. Not the PWA.
 *   /app/*     the logged-in SPA. PWA scope /app/, start_url /app/.
 *   /guest/*   the guest SPA. Network-only service worker, scope /guest/.
 *
 * The split is a path split rather than a subdomain because subdomains would
 * buy cookie isolation we do not need (guests have no cookie) at the cost of
 * TLS and CORS we would rather not have. What we DO need is service-worker
 * isolation, and that comes from scope: the longest matching scope wins, so a
 * network-only SW at /guest/ cannot be overridden by anything registered at /.
 *
 * In production Hono serves these three files (see src/server.ts). In dev,
 * Vite's history fallback only knows about index.html, so the middleware below
 * points /app and /guest at their own documents.
 */
function fillAppOrigin(): Plugin {
  return {
    name: "splitsmart-app-origin",
    transformIndexHtml(html, ctx) {
      // Production HTML keeps `__APP_ORIGIN__` so Hono can fill APP_ORIGIN at
      // request time (the Docker image is built without the public URL). Dev
      // has no Hono in front of this document, so fill it here.
      if (ctx.server == null) return html;
      const origin =
        process.env.APP_ORIGIN ?? `http://localhost:${process.env.WEB_PORT ?? 5444}`;
      return applyAppOrigin(html, origin);
    },
  };
}

function shells(): Plugin {
  return {
    name: "splitsmart-shells",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? "").split("?")[0] ?? "";

        // Anything with an extension is a real file: the service workers, the
        // manifest, /assets. Rewriting those to a document would break the
        // very SW registration this split exists for.
        if (/\.[a-z0-9]+$/i.test(path)) return next();

        if (path === "/app" || path.startsWith("/app/")) req.url = "/app.html";
        else if (path === "/guest" || path.startsWith("/guest/")) req.url = "/guest.html";

        next();
      });
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [react(), shells(), fillAppOrigin()],
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        marketing: resolve(here, "index.html"),
        app: resolve(here, "app.html"),
        guest: resolve(here, "guest.html"),
      },
    },
  },
  server: {
    // Both ports are overridable so a second stack can run beside your dev one
    // without fighting it for a port: `yarn smoke:server` puts an isolated
    // copy (its own database) on 5644/5645 while dev keeps 5444/5445.
    port: Number(process.env.WEB_PORT ?? 5444),
    // In dev the API runs as a separate process; in production the same Node
    // server serves both, so the frontend always talks to a same-origin /api.
    proxy: {
      "/api": {
        target: `http://localhost:${process.env.API_PORT ?? 5445}`,
        changeOrigin: true,
      },
    },
  },
});
