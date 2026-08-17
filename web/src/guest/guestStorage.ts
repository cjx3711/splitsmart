/**
 * Where the guest secret lives on this device.
 *
 * The app and the guest shell share an origin, so they share localStorage. The
 * keys here are namespaced `splitsmart.guest.*` for exactly that reason, and
 * the app shell clears them on boot (see entry-app.tsx): a leftover link
 * sitting next to a real session is a confusion waiting to happen, and it is
 * the session's arrival that means the link is no longer this person's
 * identity.
 *
 * These are NOT the Dexie database, and the guest shell never opens one.
 * See docs/GUEST.md, "Deliberately not doing".
 */

const LINK_KEY = "splitsmart.guest.link";
const ACTING_AS_KEY = "splitsmart.guest.actingAs";

/**
 * localStorage throws in Safari private mode and when storage is disabled. A
 * guest with no storage is not broken; they just have to keep the original URL,
 * so every accessor here fails soft.
 */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function readGuestLink(): string | null {
  return safe(() => window.localStorage.getItem(LINK_KEY), null);
}

export function writeGuestLink(secret: string): void {
  safe(() => {
    window.localStorage.setItem(LINK_KEY, secret);
    // A different link is a different scope, so a name picked under the old one
    // means nothing under the new one.
    window.localStorage.removeItem(ACTING_AS_KEY);
  }, undefined);
}

export function readActingAs(): string | null {
  return safe(() => window.localStorage.getItem(ACTING_AS_KEY), null);
}

export function writeActingAs(userId: string): void {
  safe(() => window.localStorage.setItem(ACTING_AS_KEY, userId), undefined);
}

/** Called on every /app boot, and when a link stops working. */
export function clearGuestLink(): void {
  safe(() => {
    window.localStorage.removeItem(LINK_KEY);
    window.localStorage.removeItem(ACTING_AS_KEY);
  }, undefined);
}
