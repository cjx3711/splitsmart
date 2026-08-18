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

export function readLastUserId(): string | null {
  try {
    return localStorage.getItem(LAST_USER_KEY);
  } catch {
    return null;
  }
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
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return has;
}
