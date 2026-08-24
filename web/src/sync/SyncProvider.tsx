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
 *   1. Read the last signed-in user id from `localStorage`. Just the id - the
 *      ledger lives in IndexedDB and nothing sensitive goes here.
 *   2. Open that user's Dexie and read the cached profile. Render NOW, with no
 *      network at all. This is "a logged-in reload without a connection is the
 *      app" rather than a spinner.
 *   3. Revalidate `/auth/me` in the background and start the sync loop.
 *
 * A FAILED `/auth/me` IS NOT ALWAYS A LOGOUT. Losing the network must not throw
 * the queue away - that queue is the only copy of somebody's dinner - so a
 * network failure (or any non-401 error) becomes `reconnecting`, and the app
 * keeps working from the mirror. A CONFIRMED 401, though, is the server itself
 * saying this session is not valid - the account was deleted, the session was
 * revoked, or the cookie expired - and that ends the session for real, via
 * `forceLogout`. That is still not a wipe: `forceLogout` only detaches (same
 * as the "Log out" button), so the mirror and outbox stay on disk and logging
 * back in reattaches them untouched.
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
import { LAST_USER_KEY } from "../lastUser.ts";
import { SyncEngine, type SyncStatus } from "./engine.ts";

interface SyncContextValue {
  user: ApiUser | null;
  setUser: (user: ApiUser | null) => void;
  /** True only until the cached profile (or the network) has answered once. */
  loading: boolean;
  /**
   * We are working from the mirror because the server did not answer - offline,
   * timed out, 5xx. Not a logout: a confirmed 401 is handled separately, by
   * `forceLogout`, and never surfaces as `reconnecting`.
   */
  reconnecting: boolean;
  db: LocalDb | null;
  engine: SyncEngine | null;
  status: SyncStatus | null;
  syncNow: () => void;
  /** Empty the mirror and bootstrap again. After a server-side ledger wipe. */
  resetMirror: () => Promise<void>;
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
  resetMirror: async () => {},
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
   * Detaches the mirror and the loop from whatever account they were on, but
   * does NOT delete the database: the person may well log back in, and a wipe
   * here would take an unsynced queue with it. Clearing local data is a
   * separate, deliberate action - see `resetMirror`.
   */
  const detach = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    engineRef.current = null;
    setDb(null);
    setStatus(null);
    localStorage.removeItem(LAST_USER_KEY);
  }, []);

  /**
   * The server confirmed this session is invalid (401), so it is really over -
   * unlike a dropped connection, there is nothing to reconnect to. Ends the
   * session exactly like the "Log out" button: best-effort tells the server,
   * clears who is signed in, and detaches. The mirror stays on disk, so
   * logging back in (even to the same account, moments later) picks up right
   * where it left off, queued writes included.
   */
  const forceLogout = useCallback(() => {
    void api.logout().catch(() => {});
    setUserState(null);
    setReconnecting(false);
    detach();
  }, [detach]);

  /**
   * Attaches the mirror and the loop to one account.
   *
   * Idempotent per user id, because it runs from the boot effect and again from
   * `setUser` after a login, and reopening the same Dexie would drop the running
   * engine's listeners on the floor.
   */
  const attach = useCallback(
    (userId: string): LocalDb => {
      if (engineRef.current?.selfId === userId && engineRef.current.db) {
        return engineRef.current.db;
      }

      stopRef.current?.();
      stopRef.current = null;

      const local = openLocalDb(userId);
      const engine = new SyncEngine(local, userId);
      engine.onAuthInvalid = forceLogout;
      engineRef.current = engine;

      // status() is several Dexie reads. A fast cycle announces many times, and
      // an older read can resolve after the idle one — which is how the chip
      // sat on "Syncing…" with both cursors already equal and nothing in flight.
      let statusGen = 0;
      const refresh = () => {
        const mine = ++statusGen;
        void engine.status().then((next) => {
          if (mine === statusGen) setStatus(next);
        });
      };
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
    },
    [forceLogout],
  );

  const setUser = useCallback(
    (next: ApiUser | null) => {
      setUserState(next);
      setReconnecting(false);

      if (!next) {
        // An explicit logout - the same detach that forceLogout uses.
        detach();
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
        iconPattern: next.iconPattern ?? null,
        email: next.email,
        isGhost: next.isGhost,
        defaultCurrency: next.defaultCurrency,
        mergedIntoUserId: null,
        deletedAt: null,
      });
    },
    [attach, detach],
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
          iconPattern: fresh.iconPattern ?? null,
          email: fresh.email,
          isGhost: fresh.isGhost,
          defaultCurrency: fresh.defaultCurrency,
          mergedIntoUserId: null,
          deletedAt: null,
        });
      } catch (err) {
        if (!live) return;

        // A confirmed 401 is the server itself saying this session is over -
        // the account may have been deleted, the session revoked, or the
        // cookie expired. That is a real logout regardless of what is cached;
        // forceLogout only detaches, so the mirror is untouched either way.
        if (err instanceof ApiError && err.status === 401) {
          forceLogout();
          return;
        }

        // Anything else - offline, a timeout, a 5xx - is never a wipe. With a
        // cached profile we carry on from the mirror and say so; without one
        // there is nothing to show and the login screen is right.
        if (cached) {
          setReconnecting(true);
        } else {
          setUserState(null);
        }
      } finally {
        if (live) setLoading(false);
      }
    })();

    return () => {
      live = false;
    };
  }, [attach, forceLogout]);

  // Detach on unmount, so a hot reload does not leave a second loop running.
  useEffect(() => () => stopRef.current?.(), []);

  const syncNow = useCallback(() => void engineRef.current?.sync(), []);
  const resetMirror = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const profile = user
      ? {
          id: user.id,
          name: user.name,
          nickname: user.nickname,
          iconLetters: user.iconLetters,
          iconEmoji: user.iconEmoji,
          iconHue: user.iconHue,
          iconPattern: user.iconPattern ?? null,
          email: user.email,
          isGhost: user.isGhost,
          defaultCurrency: user.defaultCurrency,
          mergedIntoUserId: null,
          deletedAt: null,
        }
      : undefined;
    // Drop the closed Dexie out of the tree first so live queries do not keep
    // reading it, then point them at the empty replacement before bootstrap.
    setDb(null);
    try {
      await engine.resetMirror(profile, setDb);
    } catch (err) {
      if (engine.db.isOpen()) setDb(engine.db);
      throw err;
    }
  }, [user]);

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
        resetMirror,
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
