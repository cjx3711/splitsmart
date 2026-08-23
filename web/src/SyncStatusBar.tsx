/**
 * The honest line about where the user's data actually is.
 *
 * Offline-first without this is a lie by omission: the app looks identical whether
 * a write is on the server or sitting in IndexedDB on one laptop, and the moment
 * somebody finds that out is the moment they stop trusting the ledger. So the bar
 * appears exactly when there is something true to say and is silent otherwise -
 * a permanent "all synced" banner is noise that trains people not to read it.
 *
 * Four things it can say, in order of how much they matter:
 *
 *   1. Writes the server REFUSED or overtook. A link to the quarantine screen.
 *   2. No connection, with the unsynced count and when we last managed a sync.
 *   3. Unsynced writes while apparently online - a failing sync rather than a
 *      missing network, which is a different problem and worth distinguishing.
 *   4. Working from the mirror because the server did not answer at all -
 *      offline, timed out, 5xx. A confirmed 401 does not reach this bar: it
 *      logs the account out (see SyncProvider's `forceLogout`) and `Protected`
 *      takes the screen to /login before this would ever render for it.
 */
import { Link } from "react-router-dom";
import { useSync } from "./sync/SyncProvider.tsx";

export function SyncStatusBar() {
  const { status, reconnecting, syncNow } = useSync();
  if (!status) return null;

  const unresolved = status.conflicts + status.rejected;
  const offline = !status.online;
  const stuck = status.online && status.pending > 0 && status.lastError !== null;

  if (unresolved === 0 && !offline && !stuck && !reconnecting) return null;

  return (
    <div className={`syncbar ${unresolved > 0 ? "syncbar-warn" : ""}`.trim()}>
      <div className="syncbar-body">
        {unresolved > 0 && (
          <span>
            {count(unresolved, "change")} could not be saved.{" "}
            <Link to="/conflicts">Review</Link>
          </span>
        )}

        {unresolved === 0 && offline && (
          <span>
            Offline. {status.pending > 0 ? `${count(status.pending, "change")} waiting. ` : ""}
            {lastSynced(status.lastSyncedAt)}
          </span>
        )}

        {unresolved === 0 && !offline && reconnecting && (
          <span>
            Working from this device&rsquo;s copy. {lastSynced(status.lastSyncedAt)}
          </span>
        )}

        {unresolved === 0 && !offline && !reconnecting && stuck && (
          <span>
            {count(status.pending, "change")} not saved yet: {status.lastError}
          </span>
        )}
      </div>

      {!offline && (
        <button className="inline secondary" onClick={syncNow} disabled={status.syncing}>
          {status.syncing ? "Syncing…" : "Sync now"}
        </button>
      )}
    </div>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * The last SUCCESSFUL sync, not the last attempt.
 *
 * "Last synced 3 minutes ago" has to mean the data actually moved, or it is worse
 * than saying nothing: someone reads it and assumes their expense is safe.
 */
function lastSynced(at: string | null): string {
  if (!at) return "Nothing has synced yet.";

  const minutes = Math.round((Date.now() - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return "Last synced just now.";
  if (minutes < 60) return `Last synced ${count(minutes, "minute")} ago.`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Last synced ${count(hours, "hour")} ago.`;
  return `Last synced on ${at.slice(0, 10)}.`;
}

/**
 * A per-row badge: pending, conflict, or rejected.
 *
 * Rendered by the expense list and the expense page. Nothing for a synced row -
 * that is the normal case, and marking it would make the exceptions harder to see,
 * not easier.
 */
export function SyncBadge({ state }: { state?: string }) {
  if (!state || state === "synced") return null;

  const label =
    state === "pending" ? "Not synced" : state === "conflict" ? "Conflict" : "Not saved";

  return <span className={`sync-badge sync-badge-${state}`}>{label}</span>;
}
