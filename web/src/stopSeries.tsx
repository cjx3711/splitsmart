/**
 * Stop or resume a repeating series without deleting any bill.
 *
 * The first bill IS the schedule. Later bills only point at it (`repeat_of`), so
 * both actions PATCH that first row: `repeatInterval: null` to stop, the paused
 * interval to resume. Resume starts from now - the server will not backfill
 * months that were missed while it was stopped.
 *
 * Recurrence is online-only (the scheduler owns `next_repeat`). The buttons are
 * wrapped in OnlineOnly and the write still goes through the outbox so a tap
 * that races a drop is not lost.
 */
import { useState } from "react";
import type { ExpenseWritePayload } from "./sync/outbox.ts";
import type { LocalExpense } from "./db/local.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { OnlineOnly } from "./OnlineOnly.tsx";
import { useSync } from "./sync/SyncProvider.tsx";
import { useLocal } from "./sync/useLocal.ts";
import {
  isRepeatInterval,
  nextOccurrenceOnOrAfter,
  type RepeatInterval,
} from "../../src/domain/recurring.ts";

function writePayloadFromTemplate(
  row: LocalExpense,
  repeatInterval: RepeatInterval | null,
): ExpenseWritePayload {
  return {
    groupId: row.groupId,
    description: row.description,
    details: row.details,
    costMinor: row.costMinor,
    currencyCode: row.currencyCode,
    date: row.date,
    categoryId: row.categoryId,
    splitType: row.splitType,
    participants: row.shares.map((s) => ({
      userId: s.userId,
      paidMinor: s.paidShareMinor,
      ...(s.splitInput !== null ? { input: s.splitInput } : {}),
    })),
    ...itemizedFromMeta(row.splitMeta, row.splitType),
    isPayment: row.isPayment,
    paymentMethod: row.paymentMethod,
    repeatInterval,
  };
}

/** Rebuild the write body from the stored template, with the schedule cleared. */
export function writePayloadStoppingRepeat(row: LocalExpense): ExpenseWritePayload {
  return writePayloadFromTemplate(row, null);
}

export function writePayloadResumingRepeat(
  row: LocalExpense,
  interval: RepeatInterval,
): ExpenseWritePayload {
  return writePayloadFromTemplate(row, interval);
}

function itemizedFromMeta(
  splitMeta: string | null,
  splitType: string,
): Pick<ExpenseWritePayload, "items" | "taxMinor" | "tipMinor"> {
  if (splitType !== "itemized" || !splitMeta) return {};
  try {
    const parsed = JSON.parse(splitMeta) as {
      items?: ExpenseWritePayload["items"];
      taxMinor?: number;
      tipMinor?: number;
    };
    return {
      ...(Array.isArray(parsed.items) ? { items: parsed.items } : {}),
      ...(typeof parsed.taxMinor === "number" ? { taxMinor: parsed.taxMinor } : {}),
      ...(typeof parsed.tipMinor === "number" ? { tipMinor: parsed.tipMinor } : {}),
    };
  } catch {
    return {};
  }
}

export function useStopSeries(templateId: string | undefined) {
  const { engine } = useSync();
  const template = useLocal(
    (db) => (templateId ? db.expenses.get(templateId) : Promise.resolve(undefined)),
    [templateId],
  );
  const [confirming, setConfirming] = useState<"stop" | "resume" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pausedInterval =
    template && isRepeatInterval(template.repeatPaused) ? template.repeatPaused : null;
  const live = Boolean(template && template.deletedAt === null && template.repeatInterval);
  const paused = Boolean(template && template.deletedAt === null && !template.repeatInterval && pausedInterval);
  const resumeOn =
    template && pausedInterval
      ? nextOccurrenceOnOrAfter(template.date, pausedInterval).slice(0, 10)
      : null;

  function requestStop() {
    setError(null);
    setConfirming("stop");
  }

  function requestResume() {
    setError(null);
    setConfirming("resume");
  }

  async function enqueue(payload: ExpenseWritePayload, failed: string) {
    if (!engine || !template) throw new Error("Not ready to save yet.");
    setBusy(true);
    try {
      await engine.enqueue({
        kind: "expense.update",
        id: template.id,
        baseVersion: template.version,
        payload,
      });
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
    } finally {
      setBusy(false);
    }
  }

  async function confirmStop() {
    if (!template) throw new Error("Not ready to save yet.");
    await enqueue(writePayloadStoppingRepeat(template), "Could not stop this series");
  }

  async function confirmResume() {
    if (!template || !pausedInterval) throw new Error("Not ready to save yet.");
    await enqueue(
      writePayloadResumingRepeat(template, pausedInterval),
      "Could not resume this series",
    );
  }

  return {
    live,
    paused,
    resumeOn,
    confirming,
    setConfirming,
    requestStop,
    requestResume,
    busy,
    error,
    confirmStop,
    confirmResume,
  };
}

export function StopRepeatingButton({ onClick }: { onClick: () => void }) {
  return (
    <OnlineOnly what="Stopping a series">
      <button type="button" className="link" onClick={onClick}>
        Stop repeating
      </button>
    </OnlineOnly>
  );
}

export function ResumeRepeatingButton({ onClick }: { onClick: () => void }) {
  return (
    <OnlineOnly what="Resuming a series">
      <button type="button" className="link" onClick={onClick}>
        Resume repeating
      </button>
    </OnlineOnly>
  );
}

export function StopSeriesDialog({
  open,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={open}
      title="Stop repeating this series?"
      confirmLabel="Stop repeating"
      busyLabel="Stopping…"
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <div className="notice">
        No more bills will be created. If you turn repeating back on later, it starts from that
        day - months that were missed while it was stopped will not be created.
      </div>
      <p style={{ margin: 0 }}>The bills already made stay.</p>
      {error && <p className="error">{error}</p>}
    </ConfirmDialog>
  );
}

export function ResumeSeriesDialog({
  open,
  busy,
  error,
  resumeOn,
  onClose,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  error?: string | null;
  resumeOn: string | null;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <ConfirmDialog
      open={open}
      title="Resume repeating?"
      confirmLabel="Resume repeating"
      busyLabel="Resuming…"
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p style={{ margin: 0 }}>
        {resumeOn
          ? `The next bill will be ${resumeOn}. Months that were missed while this was stopped will not be created.`
          : "The next bill will be created from today. Months that were missed while this was stopped will not be created."}
      </p>
      {error && <p className="error">{error}</p>}
    </ConfirmDialog>
  );
}
