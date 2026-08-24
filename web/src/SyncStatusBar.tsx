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
 *   3. Unsynced writes while apparently online - either a cycle still running
 *      or a lastError from a failed one. "Sync now" is always on this bar.
 *   4. Working from the mirror because the server did not answer at all -
 *      offline, timed out, 5xx. A confirmed 401 does not reach this bar: it
 *      logs the account out (see SyncProvider's `forceLogout`) and `Protected`
 *      takes the screen to /login before this would ever render for it.
 *
 * The header chip next to the wordmark is the always-on counterpart. A click
 * opens the status panel (cursors, local counts, reload) rather than firing a
 * sync: "Syncing…" with no numbers is why that panel exists.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  LuCloud,
  LuCloudAlert,
  LuCloudOff,
  LuCloudUpload,
} from "react-icons/lu";
import { useSync } from "./sync/SyncProvider.tsx";
import { headerSyncView, lastSynced } from "./headerSync.ts";
import { SyncDetails } from "./SyncDetails.tsx";

/** Live `navigator.onLine`, so airplane mode does not wait on a stuck cycle. */
function useNavigatorOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);
  return online;
}

const HEADER_ICONS = {
  conflict: LuCloudAlert,
  offline: LuCloudOff,
  syncing: LuCloud,
  pending: LuCloudUpload,
  synced: LuCloud,
} as const;

/** Always-visible cloud / offline / queue chip, parked next to the logo. */
export function HeaderSyncStatus() {
  const { status, reconnecting } = useSync();
  const online = useNavigatorOnline();
  const [open, setOpen] = useState(false);
  if (!status) return null;

  const view = headerSyncView({ ...status, online }, reconnecting);
  const Icon = HEADER_ICONS[view.kind];
  const hint = `${view.label}. ${view.detail}`;
  const showCount = view.count > 0;

  return (
    <>
      <button
        type="button"
        className={`sync-status sync-status-${view.kind}`}
        title={hint}
        aria-label={hint}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon size={16} className="sync-status-icon" aria-hidden />
        <span className="sync-status-label">{view.label}</span>
        {showCount && <span className="sync-status-count">{view.count}</span>}
      </button>
      <SyncDetails open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function SyncStatusBar() {
  const { status, reconnecting, syncNow } = useSync();
  if (!status) return null;

  const unresolved = status.conflicts + status.rejected;
  const offline = !status.online;
  const waiting = status.online && status.pending > 0;

  if (unresolved === 0 && !offline && !waiting && !reconnecting) return null;

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

        {unresolved === 0 && !offline && !reconnecting && waiting && (
          <span>
            {count(status.pending, "change")} not saved yet
            {status.lastError ? `: ${status.lastError}` : "."}
          </span>
        )}
      </div>

      {!offline && (
        <button className="inline secondary" onClick={syncNow} disabled={status.syncing}>
          {status.syncing ? "Saving…" : "Sync now"}
        </button>
      )}
    </div>
  );
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
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

  if (state === "pending") {
    return (
      <span className="sync-icon" title="Not yet synced" aria-label="Not yet synced">
        <LuCloudOff size={14} />
      </span>
    );
  }

  const label = state === "conflict" ? "Conflict" : "Not saved";
  return <span className={`sync-badge sync-badge-${state}`}>{label}</span>;
}
