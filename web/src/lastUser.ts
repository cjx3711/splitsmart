import { useEffect, useState } from "react";

/**
 * Which account this browser last signed into.
 *
 * `localStorage`, not a cookie: the session cookie is httpOnly and unreadable
 * here, and this is not a credential - it is the name of an IndexedDB database.
 * The marketing site peeks at it so a signed-in visit can offer "Open app"
 * instead of "Log in", without loading Dexie or asking `/auth/me`.
 */
export const LAST_USER_KEY = "splitsmart.lastUserId";

/** Same-tab companion to the `storage` event, which only fires in other tabs. */
const LAST_USER_CHANGE = "splitsmart:last-user";

export function readLastUserId(): string | null {
  try {
    return localStorage.getItem(LAST_USER_KEY);
  } catch {
    return null;
  }
}

/** Drop the local hint. Does not touch the session cookie; callers do that. */
export function clearLastUserId(): void {
  try {
    localStorage.removeItem(LAST_USER_KEY);
  } catch {
    // private mode / quota
  }
  window.dispatchEvent(new Event(LAST_USER_CHANGE));
}

/** True when this browser has a cached account and has not logged out. */
export function useHasLocalAccount(): boolean {
  const [has, setHas] = useState(() => Boolean(readLastUserId()));

  useEffect(() => {
    const sync = () => setHas(Boolean(readLastUserId()));
    const onStorage = (event: StorageEvent) => {
      if (event.key === LAST_USER_KEY || event.key === null) sync();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(LAST_USER_CHANGE, sync);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(LAST_USER_CHANGE, sync);
    };
  }, []);

  return has;
}
