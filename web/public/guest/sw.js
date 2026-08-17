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
      // Do NOT caches.delete() here. caches.keys() is origin-wide, so wiping
      // it would destroy the logged-in app shell (splitsmart-app-shell-v1)
      // the moment someone opens a claim/guest link. This worker caches
      // nothing; it should not touch what it did not create.
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
