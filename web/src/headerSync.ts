/**
 * What the header chip next to the wordmark should say.
 *
 * Pure so the priority (conflict > navigator-offline > syncing > reconnecting >
 * pending > synced) can be pinned without a browser. The component in
 * SyncStatusBar.tsx only picks the icon and the click target.
 */

export type HeaderSyncKind = "conflict" | "offline" | "syncing" | "pending" | "synced";

export type HeaderSyncInput = {
  online: boolean;
  syncing: boolean;
  pending: number;
  conflicts: number;
  rejected: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  remaining?: number | null;
  localCursor?: number;
  cloudSeq?: number | null;
  phase?: "idle" | "bootstrap" | "hydrate" | "pull" | "push";
};

export type HeaderSyncView = {
  kind: HeaderSyncKind;
  label: string;
  /** Pending, unresolved, or (while syncing) remaining count for the mobile badge. */
  count: number;
  detail: string;
};

export function headerSyncView(
  status: HeaderSyncInput,
  reconnecting: boolean,
  now = Date.now(),
): HeaderSyncView {
  const unresolved = status.conflicts + status.rejected;
  const detail =
    status.lastError && unresolved === 0 && status.online && !reconnecting
      ? status.lastError
      : lastSynced(status.lastSyncedAt, now);

  if (unresolved > 0) {
    return {
      kind: "conflict",
      label: `${count(unresolved, "change")} not saved`,
      count: unresolved,
      detail,
    };
  }
  // Navigator-offline beats a cycle that cannot finish: "Syncing…" while the
  // laptop is on airplane mode is a lie. A reconnecting tab (server 5xx, still
  // on the network) may still be mid-cycle, so that stays "Syncing…".
  if (!status.online) {
    return {
      kind: "offline",
      label: status.pending > 0 ? `Offline · ${count(status.pending, "change")} waiting` : "Offline",
      count: status.pending,
      detail: lastSynced(status.lastSyncedAt, now),
    };
  }
  if (status.syncing) {
    const behind = behindCount(status);
    const hasWork = (behind != null && behind > 0) || status.pending > 0;
    // A heartbeat asks the server even when this copy is current. Until that
    // ask finds a backlog, the chip stays Synced — "Checking…" is the same
    // lie as "Syncing…" with both cursors already equal.
    if (!hasWork) {
      if (status.phase === "bootstrap") {
        return { kind: "syncing", label: "Loading copy…", count: 0, detail };
      }
      if (status.phase === "hydrate") {
        return { kind: "syncing", label: "Updating…", count: 0, detail };
      }
      return { kind: "synced", label: "Synced", count: 0, detail };
    }
    return {
      kind: "syncing",
      label: syncingLabel(status),
      count: behind || status.pending,
      detail: lastSynced(status.lastSyncedAt, now),
    };
  }
  if (reconnecting) {
    return {
      kind: "offline",
      label: status.pending > 0 ? `Offline · ${count(status.pending, "change")} waiting` : "Offline",
      count: status.pending,
      detail: lastSynced(status.lastSyncedAt, now),
    };
  }
  if (status.pending > 0) {
    return {
      kind: "pending",
      label: `${count(status.pending, "change")} not synced`,
      count: status.pending,
      detail,
    };
  }
  return { kind: "synced", label: "Synced", count: 0, detail };
}

function behindCount(status: HeaderSyncInput): number | null {
  // Only a pull's `remaining` is work this caller still has. `cloudSeq` is
  // the global log tip and includes writes this account will never see.
  if (status.remaining != null) return status.remaining;
  return null;
}

function syncingLabel(status: HeaderSyncInput): string {
  if (status.phase === "bootstrap") return "Loading copy…";
  if (status.pending > 0) return "Saving…";
  const behind = behindCount(status);
  if (behind != null && behind > 0) {
    return `Syncing… ${formatCount(behind)} left`;
  }
  if (status.phase === "hydrate") return "Updating…";
  return "Synced";
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
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
export function lastSynced(at: string | null, now = Date.now()): string {
  if (!at) return "Nothing has synced yet.";

  const minutes = Math.round((now - new Date(at).getTime()) / 60_000);
  if (minutes < 1) return "Last synced just now.";
  if (minutes < 60) return `Last synced ${count(minutes, "minute")} ago.`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Last synced ${count(hours, "hour")} ago.`;
  return `Last synced on ${at.slice(0, 10)}.`;
}
