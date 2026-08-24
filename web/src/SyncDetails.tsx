/**
 * What the cloud chip opens: whether this copy is current, and a way to throw
 * it away and pull again.
 *
 * The chip itself can only say one short thing. The two times are the honest
 * answer a person can read: when the latest change this account can see landed
 * on the server, and when the change this device has applied landed. Comparing
 * them is match / behind / ahead — seq numbers stay off the panel, they are a
 * position in the whole-app log. "Reload from server" is the same action as
 * Settings → Clear local data, parked here because that is when you notice
 * the times look wrong.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useLiveQuery } from "dexie-react-hooks";
import { api } from "./api.ts";
import { Modal } from "./Modal.tsx";
import { copyRelation, formatLogTime, type CopyRelation } from "./copyClocks.ts";
import { lastSynced } from "./headerSync.ts";
import { useSync } from "./sync/SyncProvider.tsx";
import type { SyncStatus } from "./sync/engine.ts";

type CloudClocks = {
  visibleAt: string | null;
  cursorAt: string | null;
};

export function SyncDetails({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { status, db, syncNow, resetMirror } = useSync();
  const [cloud, setCloud] = useState<CloudClocks | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [resyncing, setResyncing] = useState(false);

  const counts = useLiveQuery(
    async () => {
      if (!db || !open) return undefined;
      const [expenses, groups, people, comments] = await Promise.all([
        db.expenses.count(),
        db.groups.count(),
        db.users.count(),
        db.comments.count(),
      ]);
      return { expenses, groups, people, comments };
    },
    [db, open],
  );

  useEffect(() => {
    if (!open) {
      setConfirming(false);
      return;
    }

    let live = true;
    const tick = async () => {
      try {
        const result = await api.syncStatus(status?.localCursor);
        if (!live) return;
        setCloud({
          visibleAt: result.visibleAt,
          cursorAt: result.cursorAt,
        });
      } catch {
        // Offline, or the session dropped. The panel still has the last known times.
      }
    };

    void tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [open, status?.localCursor]);

  if (!status) return null;

  const relation = cloud
    ? copyRelation(cloud.visibleAt, cloud.cursorAt, status.pending)
    : null;

  async function resync() {
    setResyncing(true);
    try {
      await resetMirror();
      setConfirming(false);
    } finally {
      setResyncing(false);
    }
  }

  return (
    <Modal open={open} title="This device's copy" onClose={onClose}>
      {confirming ? (
        <div className="stack">
          <p style={{ margin: 0 }}>
            Empties the copy on this device and pulls a fresh one from the server.
            Nothing on the server is affected.
          </p>
          <p className="muted" style={{ margin: 0 }}>
            Any change made here that has not synced yet will be lost.
          </p>
          <div className="sync-details-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => setConfirming(false)}
              disabled={resyncing}
            >
              Cancel
            </button>
            <button type="button" onClick={() => void resync()} disabled={resyncing}>
              {resyncing ? "Reloading…" : "Reload from server"}
            </button>
          </div>
        </div>
      ) : (
        <div className="stack sync-details">
          <p className="sync-details-lede">{phaseLine(status, relation)}</p>

          <section>
            <h3 className="sync-details-heading">Server</h3>
            <dl className="sync-details-dl">
              <div>
                <dt>Latest change</dt>
                <dd>{cloud ? formatClock(cloud.visibleAt) : "…"}</dd>
              </div>
              <div>
                <dt>Connection</dt>
                <dd>{status.online ? "Reachable" : "Unreachable"}</dd>
              </div>
            </dl>
          </section>

          <section>
            <h3 className="sync-details-heading">This device</h3>
            <dl className="sync-details-dl">
              <div>
                <dt>Latest change</dt>
                <dd>{cloud ? formatClock(cloud.cursorAt) : "…"}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  {relation ? (
                    <span className={`sync-details-relation sync-details-relation-${relation.kind}`}>
                      {relation.label}
                    </span>
                  ) : (
                    "…"
                  )}
                </dd>
              </div>
              <div>
                <dt>Last synced</dt>
                <dd>{lastSynced(status.lastSyncedAt)}</dd>
              </div>
              {status.lastError && (
                <div>
                  <dt>Last error</dt>
                  <dd className="sync-details-error">{status.lastError}</dd>
                </div>
              )}
            </dl>
          </section>

          <section>
            <h3 className="sync-details-heading">On this device</h3>
            <dl className="sync-details-dl">
              <div>
                <dt>Expenses</dt>
                <dd>{counts ? formatCount(counts.expenses) : "…"}</dd>
              </div>
              <div>
                <dt>Groups</dt>
                <dd>{counts ? formatCount(counts.groups) : "…"}</dd>
              </div>
              <div>
                <dt>People</dt>
                <dd>{counts ? formatCount(counts.people) : "…"}</dd>
              </div>
              <div>
                <dt>Comments</dt>
                <dd>{counts ? formatCount(counts.comments) : "…"}</dd>
              </div>
              <div>
                <dt>Waiting to save</dt>
                <dd>{formatCount(status.pending)}</dd>
              </div>
              {status.conflicts + status.rejected > 0 && (
                <div>
                  <dt>Could not save</dt>
                  <dd>
                    <Link to="/conflicts" onClick={onClose}>
                      {status.conflicts + status.rejected}{" "}
                      {status.conflicts + status.rejected === 1 ? "change" : "changes"}
                    </Link>
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <div className="sync-details-actions">
            <button
              type="button"
              className="secondary"
              onClick={syncNow}
              disabled={!status.online || status.syncing}
            >
              {status.syncing ? "Syncing…" : "Sync now"}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setConfirming(true)}
              disabled={resyncing}
            >
              Reload from server
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function phaseLine(status: SyncStatus, relation: CopyRelation | null): string {
  if (!status.online) return "Working from this device. The server cannot be reached.";
  if (!status.bootstrapped) return "Loading this device's copy from the server.";
  switch (status.phase) {
    case "bootstrap":
      return "Loading this device's copy from the server.";
    case "hydrate":
      return "Updating fields this copy was missing.";
    case "push":
      return status.pending > 0
        ? "Saving changes from this device."
        : (relation?.sentence ?? "This copy matches the server.");
    case "pull":
      return status.remaining != null && status.remaining > 0
        ? "Applying remaining changes."
        : (relation?.sentence ?? "This copy matches the server.");
    default:
      return relation?.sentence ?? "This copy matches the server.";
  }
}

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

function formatClock(ts: string | null): string {
  if (!ts) return "No changes yet";
  return formatLogTime(ts);
}
