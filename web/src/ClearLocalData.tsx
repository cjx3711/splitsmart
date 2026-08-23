/**
 * One-step confirmation for wiping this device's local copy only.
 *
 * Unlike WipeLedgerButton, nothing on the server is touched: this empties
 * Dexie (including the outbox - anything not yet synced is lost) and
 * bootstraps fresh from the server. For when the local mirror looks stuck or
 * wrong and a clean re-pull is the fastest way out.
 */
import { useState } from "react";
import { useSync } from "./sync/SyncProvider.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

export function ClearLocalDataButton() {
  const { resetMirror } = useSync();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  async function clear() {
    setBusy(true);
    try {
      await resetMirror();
      setOpen(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="secondary" type="button" style={{ width: "auto" }} onClick={() => setOpen(true)}>
        Clear local data and resync
      </button>

      <ConfirmDialog
        open={open}
        title="Clear this device's local data?"
        confirmLabel="Clear and resync"
        busyLabel="Clearing…"
        busy={busy}
        onClose={() => setOpen(false)}
        onConfirm={clear}
      >
        <p style={{ margin: 0 }}>
          Empties this device&apos;s offline copy and pulls a fresh one from
          the server. Nothing on the server is affected.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          Any change made on this device that has not synced yet will be lost.
        </p>
      </ConfirmDialog>
    </>
  );
}
