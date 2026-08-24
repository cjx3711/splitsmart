/**
 * How this device's copy sits against the server, from the two times the
 * status panel shows.
 *
 * Seq numbers stay out of it: `head` is the whole-app log. These clocks are
 * this caller's latest visible log row versus the row at this device's cursor.
 * Pending local writes make the device ahead even when the times match —
 * those writes are not on the server yet.
 */

export type CopyRelationKind = "match" | "behind" | "ahead" | "unknown";

export type CopyRelation = {
  kind: CopyRelationKind;
  /** One word (or short phrase) for the Status row. */
  label: string;
  /** Sentence for the panel lede when nothing else is in flight. */
  sentence: string;
};

export function copyRelation(
  serverAt: string | null,
  deviceAt: string | null,
  pending = 0,
): CopyRelation {
  const server = parseLogTime(serverAt);
  const device = parseLogTime(deviceAt);

  if (server === null && device === null) {
    return pending > 0 ? ahead(null, "not saved yet") : match();
  }
  if (server === null) return ahead(null);
  if (device === null) return behind(null);

  const delta = server - device;
  if (delta > 0) return behind(delta);
  if (delta < 0) return ahead(-delta);
  if (pending > 0) return ahead(null, "not saved yet");
  return match();
}

/** `sync_log.server_ts` is SQLite `datetime('now')`: UTC, no timezone suffix. */
export function parseLogTime(ts: string | null): number | null {
  if (!ts) return null;
  const date = new Date(ts.includes("T") ? ts : `${ts.replace(" ", "T")}Z`);
  const ms = date.getTime();
  return Number.isNaN(ms) ? null : ms;
}

export function formatLogTime(ts: string): string {
  const ms = parseLogTime(ts);
  return ms === null ? ts : new Date(ms).toLocaleString();
}

function match(): CopyRelation {
  return {
    kind: "match",
    label: "Match",
    sentence: "This copy matches the server.",
  };
}

function behind(deltaMs: number | null): CopyRelation {
  const lag = formatDelta(deltaMs);
  return {
    kind: "behind",
    label: lag ? `Behind · ${lag}` : "Behind",
    sentence: lag
      ? `This copy is ${lag} behind the server.`
      : "This copy is behind the server.",
  };
}

function ahead(deltaMs: number | null, reason?: string): CopyRelation {
  const lead = reason ?? formatDelta(deltaMs);
  return {
    kind: "ahead",
    label: lead ? `Ahead · ${lead}` : "Ahead",
    sentence: reason
      ? "Changes on this device are waiting to be saved."
      : lead
        ? `This copy is ${lead} ahead of the server.`
        : "This copy is ahead of the server.",
  };
}

function formatDelta(ms: number | null): string | null {
  if (ms === null) return null;
  const seconds = Math.round(ms / 1000);
  if (seconds < 1) return null;
  if (seconds < 60) return count(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return count(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return count(hours, "hour");
  return count(Math.round(hours / 24), "day");
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
