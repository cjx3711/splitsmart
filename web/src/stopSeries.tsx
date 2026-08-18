/**
 * Stop a repeating series without deleting any bill.
 *
 * The first bill IS the schedule. Later bills only point at it (`repeat_of`), so
 * stopping always PATCHes that first row with `repeatInterval: null`. The copies
 * stay; they just stop arriving.
 *
 * Recurrence is online-only (the scheduler owns `next_repeat`). The button is
 * wrapped in OnlineOnly and this write still goes through the outbox so a tap
 * that races a drop is not lost.
 */
import { useState } from "react";
import type { ExpenseWritePayload } from "./sync/outbox.ts";
import type { LocalExpense } from "./db/local.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { OnlineOnly } from "./OnlineOnly.tsx";
import { useSync } from "./sync/SyncProvider.tsx";
import { useLocal } from "./sync/useLocal.ts";

/** Rebuild the write body from the stored template, with the schedule cleared. */
export function writePayloadStoppingRepeat(row: LocalExpense): ExpenseWritePayload {
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
    repeatInterval: null,
  };
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
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const live = Boolean(template && template.deletedAt === null && template.repeatInterval);

  function requestStop() {
    setError(null);
    setConfirming(true);
  }

  async function confirmStop() {
    if (!engine || !template) throw new Error("Not ready to save yet.");
    setBusy(true);
    try {
      await engine.enqueue({
        kind: "expense.update",
        id: template.id,
        baseVersion: template.version,
        payload: writePayloadStoppingRepeat(template),
      });
      setConfirming(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not stop this series");
    } finally {
      setBusy(false);
    }
  }

  return { live, confirming, setConfirming, requestStop, busy, error, confirmStop };
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
      title="Stop repeating?"
      confirmLabel="Stop repeating"
      busyLabel="Stopping…"
      busy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
    >
      <p style={{ margin: 0 }}>No more bills will be created. The bills already made stay.</p>
      {error && <p className="error">{error}</p>}
    </ConfirmDialog>
  );
}

