/*
 * The guest service worker. It exists to do NOTHING, on purpose.
 *
 * Service workers are origin-wide unless scoped, and the longest matching scope
 * wins. Without this file, a service worker registered at `/` (the app's, or a
 * leftover from an older build) would control `/guest/` too, and could serve a
 * guest last week's balances out of its cache after their link was revoked.
 *
 * So this one claims `/guest/` and passes every request straight to the
 * network. Offline means a needs-connection screen, not a stale ledger. That is
 * the whole point of a revocable link: see docs/GUEST.md, "Two shells".
 *
 * Nothing is precached, nothing is stored, and `caches` is never touched.
 */

self.addEventListener("install", () => {
  // Take over from any wider-scoped worker immediately rather than waiting for
  // every /guest tab to close. A stale controller here is the failure mode.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Belt and braces: if an earlier build ever cached anything under this
      // origin, none of it should survive here.
      if (self.caches) {
        for (const key of await caches.keys()) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

// No fetch handler at all would also be network-only, but an explicit one that
// never calls respondWith() documents the intent and stops someone "helpfully"
// adding a cache-first strategy later without reading the comment above.
self.addEventListener("fetch", () => {
  /* pass through to the network, always */
});
