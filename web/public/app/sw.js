/*
 * The app service worker, scoped to /app/.
 *
 * It exists NOW so the scope is claimed before offline writes land
 * (docs/OFFLINE.md): a worker registered later at a wider scope could otherwise
 * end up controlling /guest/, which must never be served from a cache.
 *
 * It caches the shell only: the /app document, its build assets, and the
 * manifest and icons an installed app needs before it has painted anything. It
 * does NOT cache /api/v1 responses, ever. What makes the app work offline is the
 * Dexie mirror (web/src/db/local.ts), not this file; a cached balance is a wrong
 * balance, and a cached 200 on an authenticated route outlives the session that
 * earned it.
 */

const SHELL_CACHE = "splitsmart-app-shell-v1";

/**
 * Precached on install, so an installed app launched offline has an icon and a
 * document rather than a browser error page. Everything else under /app is
 * cached lazily as it is fetched.
 *
 * `addAll` is all-or-nothing: one 404 here fails the install and leaves the old
 * worker in place, which is why this list is short and only names files
 * src/server.ts serves explicitly.
 */
const PRECACHE = [
  "/app",
  "/app/manifest.webmanifest",
  "/app/icons/icon-192.png",
  "/app/icons/icon-512.png",
  "/app/icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key !== SHELL_CACHE) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never the API. A cached balance is a wrong balance, and a cached 200 on an
  // authenticated route outlives the session that earned it.
  if (url.pathname.startsWith("/api/")) return;

  // Never anything outside this scope, /guest/ above all.
  if (!url.pathname.startsWith("/app")) return;

  // Navigations: network first, shell from cache only when the network fails,
  // so a deploy is picked up on the next load rather than on the next month.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put("/app", copy));
          return response;
        })
        .catch(async () => (await caches.match("/app")) ?? Response.error()),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            void caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
