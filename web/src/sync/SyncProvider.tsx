/**
 * The session, the mirror and the sync loop, as one React provider.
 *
 * These three are one thing because they cannot be resolved independently: the
 * mirror's database name is namespaced by user id, and offline the only place the
 * user id comes FROM is the mirror. Splitting them would mean a provider that
 * cannot start until the network answers, which is the exact failure this whole
 * feature exists to remove.
 *
 * BOOT ORDER, and every step of it matters:
 *
 *   1. Read the last signed-in user id from `localStorage`. Just the id — the
 *      ledger lives in IndexedDB and nothing sensitive goes here.
 *   2. Open that user's Dexie and read the cached profile. Render NOW, with no
 *      network at all. This is "a logged-in reload without a connection is the
 *      app" rather than a spinner.
 *   3. Revalidate `/auth/me` in the background and start the sync loop.
 *
 * A FAILED `/auth/me` IS NOT A LOGOUT. Losing the network, or a 30-day session
 * cookie expiring while unsynced expenses are queued, must not throw the queue
 * away — that queue is the only copy of somebody's dinner. Both cases become
 * `reconnecting`, and the app keeps working from the mirror. Only an explicit
 * logout clears anything.
 *
 * A GUEST-LINK VISITOR NEVER REACHES THIS. Nothing under web/src/guest imports it,
 * `entry-app.tsx` clears any leftover link secret, and a link-scoped identity is
 * never used as the Dexie namespace: a link is revocable and a local ledger is not.
 * See docs/GUEST.md.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError, type ApiUser } from "../api.ts";
import { getMeta, openLocalDb, setMeta, type LocalDb } from "../db/local.ts";
import { localProfile } from "../db/queries.ts";
import { SyncEngine, type SyncStatus } from "./engine.ts";

/**
 * Which account this browser last signed into.
 *
 * `localStorage`, not a cookie: the session cookie is httpOnly and unreadable
 * here, and this is not a credential — it is the name of an IndexedDB database.
 * Losing it costs a bootstrap, not a session.
 */
const LAST_USER_KEY = "splitsmart.lastUserId";

interface SyncContextValue {
  user: ApiUser | null;
  setUser: (user: ApiUser | null) => void;
  /** True only until the cached profile (or the network) has answered once. */
  loading: boolean;
  /**
   * We are working from the mirror because the server did not answer, or answered
   * 401 while we still have a cached profile. Not a logout.
   */
  reconnecting: boolean;
  db: LocalDb | null;
  engine: SyncEngine | null;
  status: SyncStatus | null;
  syncNow: () => void;
}

const SyncContext = createContext<SyncContextValue>({
  user: null,
  setUser: () => {},
  loading: true,
  reconnecting: false,
  db: null,
  engine: null,
  status: null,
  syncNow: () => {},
});

export function useSync() {
  return useContext(SyncContext);
}

/** The mirror, or null before a session exists. Screens read through this. */
export function useLocalDb(): LocalDb | null {
  return useContext(SyncContext).db;
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<ApiUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [db, setDb] = useState<LocalDb | null>(null);
  const [status, setStatus] = useState<SyncStatus | null>(null);

  const engineRef = useRef<SyncEngine | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  /**
   * Attaches the mirror and the loop to one account.
   *
   * Idempotent per user id, because it runs from the boot effect and again from
   * `setUser` after a login, and reopening the same Dexie would drop the running
   * engine's listeners on the floor.
   */
  const attach = useCallback((userId: string): LocalDb => {
    if (engineRef.current?.selfId === userId && engineRef.current.db) {
      return engineRef.current.db;
    }

    stopRef.current?.();
    stopRef.current = null;

    const local = openLocalDb(userId);
    const engine = new SyncEngine(local, userId);
    engineRef.current = engine;

    const refresh = () => void engine.status().then(setStatus);
    const unsubscribe = engine.onChange(refresh);
    const stopTriggers = engine.start();
    refresh();

    stopRef.current = () => {
      unsubscribe();
      stopTriggers();
    };

    setDb(local);
    localStorage.setItem(LAST_USER_KEY, userId);
    return local;
  }, []);

  const setUser = useCallback(
    (next: ApiUser | null) => {
      setUserState(next);
      setReconnecting(false);

      if (!next) {
        // An explicit logout. Detach and forget which account this was, but do NOT
        // delete the database: the person may well log back in, and a wipe here
        // would take an unsynced queue with it. Clearing local data is a separate,
        // deliberate action.
        stopRef.current?.();
        stopRef.current = null;
        engineRef.current = null;
        setDb(null);
        setStatus(null);
        localStorage.removeItem(LAST_USER_KEY);
        return;
      }

      const local = attach(next.id);
      void setMeta(local, "profile", {
        id: next.id,
        name: next.name,
        nickname: next.nickname,
        iconLetters: next.iconLetters,
        iconEmoji: next.iconEmoji,
        iconHue: next.iconHue,
        email: next.email,
        isGhost: next.isGhost,
        defaultCurrency: next.defaultCurrency,
        mergedIntoUserId: null,
        deletedAt: null,
      });
    },
    [attach],
  );

  useEffect(() => {
    let live = true;

    void (async () => {
      // --- step 1 and 2: render from the mirror, with no network ------------
      const cachedId = localStorage.getItem(LAST_USER_KEY);
      let cached: ApiUser | null = null;

      if (cachedId) {
        const local = attach(cachedId);
        cached = await localProfile(local);
        if (live && cached) {
          setUserState(cached);
          setLoading(false);
        }
      }

      // --- step 3: revalidate ----------------------------------------------
      try {
        const { user: fresh } = await api.me();
        if (!live) return;

        setUserState(fresh);
        setReconnecting(false);

        // A different account on this browser. Attach to theirs; the previous
        // mirror stays on disk, which is what makes switching back instant.
        const local = attach(fresh.id);
        await setMeta(local, "profile", {
          id: fresh.id,
          name: fresh.name,
          nickname: fresh.nickname,
          iconLetters: fresh.iconLetters,
          iconEmoji: fresh.iconEmoji,
          iconHue: fresh.iconHue,
          email: fresh.email,
          isGhost: fresh.isGhost,
          defaultCurrency: fresh.defaultCurrency,
          mergedIntoUserId: null,
          deletedAt: null,
        });
      } catch (err) {
        if (!live) return;

        // Never a wipe. With a cached profile we carry on from the mirror and say
        // so; without one there is nothing to show and the login screen is right.
        if (cached) {
          setReconnecting(true);
        } else {
          setUserState(null);
          if (cachedId && err instanceof ApiError && err.status === 401) {
            // Signed out for real, and we had nothing cached to fall back on.
            localStorage.removeItem(LAST_USER_KEY);
          }
        }
      } finally {
        if (live) setLoading(false);
      }
    })();

    return () => {
      live = false;
    };
  }, [attach]);

  // Detach on unmount, so a hot reload does not leave a second loop running.
  useEffect(() => () => stopRef.current?.(), []);

  const syncNow = useCallback(() => void engineRef.current?.sync(), []);

  return (
    <SyncContext.Provider
      value={{
        user,
        setUser,
        loading,
        reconnecting,
        db,
        engine: engineRef.current,
        status,
        syncNow,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}

/** Whether a bootstrap has finished, so a screen can tell empty from not-yet. */
export async function isMirrorReady(db: LocalDb): Promise<boolean> {
  return (await getMeta(db, "bootstrapped")) === true;
}
