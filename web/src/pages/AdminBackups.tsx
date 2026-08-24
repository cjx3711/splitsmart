/**
 * Operator view of daily S3 database backups. Config, scheduler, run
 * history. Online-only — the bucket and the runs table live on the server.
 */
import { useCallback, useEffect, useState } from "react";
import { api, type AdminBackupsResponse, type BackupRunSummary } from "../api.ts";
import { HelpTip } from "../HelpTip.tsx";
import { NeedsConnection, useOnline } from "../OnlineOnly.tsx";
import { AdminNav } from "./AdminNav.tsx";

const POLL_INTERVAL_MS = 10_000;
const RELATIVE_TICK_MS = 30_000;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  const digits = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[i]}`;
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString();
}

function formatRelative(iso: string | null, now: Date): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const delta = now.getTime() - date.getTime();
  const abs = Math.abs(delta);
  const suffix = delta >= 0 ? "ago" : "from now";
  if (abs < 45_000) return "just now";
  if (abs < 90_000) return `1 min ${suffix}`;
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min ${suffix}`;
  if (abs < 90 * 60_000) return `1 hr ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} hr ${suffix}`;
  const days = Math.round(abs / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} ${suffix}`;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`admin-pill admin-pill-${status}`}>{status}</span>;
}

function TimestampBlock({ iso, now }: { iso: string | null; now: Date }) {
  if (!iso) return <div>—</div>;
  return (
    <>
      <div>{formatRelative(iso, now)}</div>
      <div className="muted">{formatWhen(iso)}</div>
    </>
  );
}

export function AdminBackups() {
  const online = useOnline();
  const [data, setData] = useState<AdminBackupsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [triggering, setTriggering] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), RELATIVE_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    if (!online) return;
    setLoading(true);
    setError(null);
    try {
      setData(await api.adminBackups());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load backups");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [online]);

  useEffect(() => {
    void load();
  }, [load]);

  const isBusy =
    data?.scheduler.inFlight === true ||
    (data?.runs ?? []).some((run) => run.status === "running");

  useEffect(() => {
    if (!isBusy || !online) return;
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [isBusy, online, load]);

  async function trigger(force: boolean) {
    setTriggering(true);
    setNotice(null);
    try {
      const result = await api.adminTriggerBackup(force);
      if (result.status === 202) {
        const run = result.body.run;
        setNotice(
          run
            ? `Started run ${run.id} for ${run.backupDate}. This page polls while it runs.`
            : "Backup started.",
        );
      } else if (result.status === 409) {
        setNotice(
          `${result.body.detail ?? "A backup is already running."} Use “Force run” to record an extra run that does not own the day.`,
        );
      } else if (result.status === 503) {
        setNotice("Backups are not configured, so nothing was started.");
      } else {
        setNotice(
          result.body.detail ?? `Could not start a backup (HTTP ${result.status}).`,
        );
      }
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not start a backup.");
    } finally {
      setTriggering(false);
    }
  }

  if (!online) {
    return (
      <>
        <AdminNav current="backups" />
        <div className="page-head">
          <h1 className="with-help">
            Backups
            <HelpTip label="About database backups">
              Daily gzipped snapshots of this server's SQLite file, uploaded to
              S3-compatible storage. Dailies older than the retention window
              are deleted; the first successful backup of each ISO week is kept
              forever.
            </HelpTip>
          </h1>
        </div>
        <NeedsConnection what="Database backups" />
      </>
    );
  }

  const config = data?.config;
  const scheduler = data?.scheduler;
  const stats = data?.stats;
  const runs = data?.runs ?? [];

  return (
    <>
      <AdminNav current="backups" />
      <div className="page-head">
        <h1 className="with-help">
          Backups
          <HelpTip label="About database backups">
            Daily gzipped snapshots of this server's SQLite file, uploaded to
            S3-compatible storage. Dailies older than the retention window are
            deleted; the first successful backup of each ISO week is kept
            forever. The backup date is a UTC calendar day.
          </HelpTip>
        </h1>
        <div className="page-actions">
          <button type="button" className="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? "Refreshing…" : "Refresh"}
          </button>
          <button type="button" onClick={() => void trigger(false)} disabled={triggering}>
            {triggering ? "Starting…" : "Back up now"}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => void trigger(true)}
            disabled={triggering}
            title="Runs even if today is already claimed. The extra run is history and does not own the day."
          >
            Force run
          </button>
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {stats && stats.consecutiveFailures > 0 && (
        <p className="error">
          {stats.consecutiveFailures} backup
          {stats.consecutiveFailures === 1 ? "" : "s"} failed in a row.
          {stats.lastFailure?.error ? ` ${stats.lastFailure.error}` : ""}
        </p>
      )}
      {data?.databaseError && (
        <p className="error">
          Could not read the backup runs table. {data.databaseError}
        </p>
      )}
      {notice && <p className="notice">{notice}</p>}

      <div className="admin-backup-cards">
        <div className="admin-backup-card">
          <h2>Last success</h2>
          {stats?.lastSuccess ? (
            <div className="admin-backup-card-body">
              <div>{stats.lastSuccess.backupDate}</div>
              <TimestampBlock iso={stats.lastSuccess.finishedAt} now={now} />
              <div>
                {formatBytes(stats.lastSuccess.compressedBytes ?? 0)} compressed
                {stats.lastSuccess.isWeekly ? " · kept as this week's weekly" : ""}
              </div>
            </div>
          ) : (
            <p className="muted">No successful runs yet</p>
          )}
        </div>
        <div className="admin-backup-card">
          <h2>Last failure</h2>
          {stats?.lastFailure ? (
            <div className="admin-backup-card-body">
              <div>
                {stats.lastFailure.backupDate}{" "}
                <StatusPill status={stats.lastFailure.status} />
              </div>
              <TimestampBlock iso={stats.lastFailure.finishedAt} now={now} />
              <div className="admin-backup-error">{stats.lastFailure.error ?? "—"}</div>
            </div>
          ) : (
            <p className="muted">No failures recorded</p>
          )}
        </div>
        <div className="admin-backup-card admin-backup-card-wide">
          <h2>Total stored</h2>
          {data?.storage ? (
            <div className="admin-backup-card-body">
              <div className="admin-backup-total">{formatBytes(data.storage.totalBytes)}</div>
              <div>
                {data.storage.dailyObjectCount}{" "}
                {data.storage.dailyObjectCount === 1 ? "daily" : "dailies"} (
                {formatBytes(data.storage.dailyBytes)}) · {data.storage.weeklyObjectCount}{" "}
                {data.storage.weeklyObjectCount === 1 ? "weekly" : "weeklies"} (
                {formatBytes(data.storage.weeklyBytes)})
              </div>
              <p className="muted">
                Dailies older than {config?.retentionDays ?? "the retention window"} days
                are deleted. Weeklies are kept forever. The local snapshot is
                removed after upload.
              </p>
            </div>
          ) : (
            <p className="muted">
              {data?.storageError
                ? data.storageError
                : config?.status === "ready"
                  ? "Could not read bucket size."
                  : "Unavailable until backups are configured."}
            </p>
          )}
        </div>
      </div>

      {config && scheduler && (
        <ConfigBlock config={config} scheduler={scheduler} />
      )}

      <h2 className="admin-backup-runs-heading">Runs</h2>
      {runs.length === 0 ? (
        <p className="muted">No backup runs recorded yet.</p>
      ) : (
        <div className="admin-backup-table-wrap">
          <table className="admin-backup-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Date</th>
                <th>Status</th>
                <th>Weekly</th>
                <th>Trigger</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Source</th>
                <th>Size</th>
                <th title="Old daily objects this run deleted from the bucket. The backup that just finished is kept.">
                  Pruned
                </th>
                <th>Key</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <RunRow key={run.id} run={run} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {stats && (
        <p className="muted">
          Showing {runs.length} of {stats.total} recorded runs, newest first.
        </p>
      )}
    </>
  );
}

function RunRow({ run }: { run: BackupRunSummary }) {
  return (
    <tr>
      <td>{run.id}</td>
      <td>{run.backupDate}</td>
      <td>
        <StatusPill status={run.status} />
        {run.status === "abandoned" && run.dailyKey && (
          <div className="muted">uploaded, not recorded</div>
        )}
      </td>
      <td>{run.isWeekly ? "yes" : "no"}</td>
      <td>
        {run.trigger}
        {run.attempt > 1 && <div className="muted">attempt {run.attempt}</div>}
      </td>
      <td>{formatWhen(run.startedAt)}</td>
      <td>{formatDuration(run.durationMs)}</td>
      <td>{run.sourceBytes !== null ? formatBytes(run.sourceBytes) : "—"}</td>
      <td>
        {run.compressedBytes !== null ? formatBytes(run.compressedBytes) : "—"}
        {run.snapshotBytes !== null && (
          <div className="muted">from {formatBytes(run.snapshotBytes)}</div>
        )}
      </td>
      <td>{run.prunedObjectCount ?? "—"}</td>
      <td className="admin-backup-key">
        {run.dailyKey ?? "—"}
        {run.weeklyKey && <div>{run.weeklyKey}</div>}
      </td>
      <td className="admin-backup-error">{run.error ?? "—"}</td>
    </tr>
  );
}

function ConfigBlock({
  config,
  scheduler,
}: {
  config: AdminBackupsResponse["config"];
  scheduler: AdminBackupsResponse["scheduler"];
}) {
  const hasProblems = config.problems.length > 0 || scheduler.state === "unknown";
  return (
    <details className="admin-backup-config" open={hasProblems}>
      <summary>
        Configuration <StatusPill status={config.status} />
        <span className="muted">
          {" "}
          · scheduler {scheduler.state}
          {scheduler.inFlight ? " · run in flight" : ""}
        </span>
      </summary>

      {config.problems.length > 0 && (
        <p className="error">
          Backups are disabled because the configuration is incomplete.{" "}
          {`${config.problems
            .map(
              (p) => `${p.key} is ${p.reason}${p.hint ? ` (${p.hint})` : ""}`,
            )
            .join("; ")}.`}
        </p>
      )}
      {scheduler.state === "unknown" && (
        <p className="error">{scheduler.reason}</p>
      )}

      <div className="admin-backup-table-wrap">
        <table className="admin-backup-table">
          <tbody>
            <ConfigRow label="Config status">{config.status}</ConfigRow>
            <ConfigRow label="Scheduler">
              {scheduler.state}
              {scheduler.reason && scheduler.state !== "unknown"
                ? ` — ${scheduler.reason}`
                : ""}
            </ConfigRow>
            <ConfigRow label="Run in flight">
              {scheduler.inFlight
                ? `yes (run ${scheduler.currentRunId ?? "?"})`
                : "no"}
            </ConfigRow>
            <ConfigRow label="Tick">
              {scheduler.tickMinutes ? `every ${scheduler.tickMinutes} min` : "—"}
            </ConfigRow>
            <ConfigRow label="Scheduler started">{formatWhen(scheduler.startedAt)}</ConfigRow>
            <ConfigRow label="Last tick">{formatWhen(scheduler.lastTickAt)}</ConfigRow>
            <ConfigRow label="Next tick">{formatWhen(scheduler.nextTickAt)}</ConfigRow>
            <ConfigRow label="Next hour gate (UTC)">
              {formatWhen(scheduler.nextDueAt)}
            </ConfigRow>
            {scheduler.lastError && (
              <ConfigRow label="Last runner error">
                <span className="admin-backup-error">
                  {scheduler.lastError}
                  {scheduler.lastErrorAt ? ` (${formatWhen(scheduler.lastErrorAt)})` : ""}
                </span>
              </ConfigRow>
            )}
            <ConfigRow label="Bucket">{config.bucket ?? "—"}</ConfigRow>
            <ConfigRow label="Endpoint">{config.endpoint ?? "—"}</ConfigRow>
            <ConfigRow label="Region">{config.region ?? "—"}</ConfigRow>
            <ConfigRow label="Path style">{config.forcePathStyle ?? "—"}</ConfigRow>
            <ConfigRow label="Key prefix">
              {config.keyPrefix === "" ? "(none)" : (config.keyPrefix ?? "—")}
            </ConfigRow>
            <ConfigRow label="Checksum mode">{config.checksumMode ?? "—"}</ConfigRow>
            <ConfigRow label="Access key id">{config.accessKeyId ?? "not set"}</ConfigRow>
            <ConfigRow label="Secret access key">
              {config.hasSecretAccessKey ? "set" : "not set"}
            </ConfigRow>
            <ConfigRow label="Hour (UTC)">{config.hourUtc ?? "—"}</ConfigRow>
            <ConfigRow label="Daily retention">
              {config.retentionDays ? `${config.retentionDays} days` : "—"}
            </ConfigRow>
            <ConfigRow label="Attempts per day">{config.maxAttemptsPerDay ?? "—"}</ConfigRow>
            <ConfigRow label="Retry backoff">
              {config.retryBackoffMinutes ? `${config.retryBackoffMinutes} min` : "—"}
            </ConfigRow>
            <ConfigRow label="Stale after">
              {config.staleAfterMinutes ? `${config.staleAfterMinutes} min` : "—"}
            </ConfigRow>
            <ConfigRow label="Snapshot directory">{config.tmpDir ?? "—"}</ConfigRow>
            <ConfigRow label="Database">{config.dbPath}</ConfigRow>
          </tbody>
        </table>
      </div>
      <p className="muted">
        A finished backup is uploaded and kept. Dailies older than the
        retention window are deleted; the first successful backup of each ISO
        week is copied under <code>weekly/</code> and never pruned. The local
        snapshot file is removed after upload. Timestamps render in this
        browser's timezone; the backup date is a UTC calendar day.
      </p>
    </details>
  );
}

function ConfigRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{children}</td>
    </tr>
  );
}
