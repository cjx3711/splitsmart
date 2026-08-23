/**
 * Two-step confirmation for wiping this account's ledger.
 *
 * Step 1 is a normal "are you sure". Step 2 requires typing DELETE ALL DATA,
 * which is also what the server checks, so a stray click or a stray POST
 * cannot do this.
 */
import { useState } from "react";
import { api, ApiError } from "./api.ts";
import { useSync } from "./sync/SyncProvider.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { Modal } from "./Modal.tsx";

const CONFIRM_PHRASE = "DELETE ALL DATA";

export function WipeLedgerButton({
  onWiped,
}: {
  onWiped?: () => void;
}) {
  const { resetMirror } = useSync();
  const [step, setStep] = useState<"closed" | "confirm" | "type">("closed");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (busy) return;
    setStep("closed");
    setTyped("");
    setError(null);
  }

  async function wipe() {
    setBusy(true);
    setError(null);
    try {
      await api.importWipe(CONFIRM_PHRASE);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not wipe this account's data");
      setBusy(false);
      return;
    }

    // Past this line the server has already committed, so nothing below may
    // report failure: telling someone the wipe failed when their ledger is gone
    // sends them to do it again, and the second attempt looks like a no-op.
    // A mirror that will not clear is a stale local cache, not lost data, and
    // the next sync reconciles it.
    try {
      await resetMirror();
    } catch (err) {
      console.error("Wipe succeeded but the local mirror did not reset:", err);
    }
    setStep("closed");
    setTyped("");
    setBusy(false);
    onWiped?.();
  }

  return (
    <>
      <button className="danger" type="button" style={{ width: "auto" }} onClick={() => setStep("confirm")}>
        Delete all my data
      </button>

      <ConfirmDialog
        open={step === "confirm"}
        title="Delete all of this account's data?"
        confirmLabel="Continue"
        onClose={close}
        onConfirm={() => setStep("type")}
      >
        <p style={{ margin: 0 }}>
          This permanently removes your groups, friends, expenses, comments and
          guest links so you can import from Splitwise again. Your login stays.
          Placeholder people created for this import are deleted.
        </p>
        <p className="muted" style={{ margin: 0 }}>
          If another real account shares a group or expense with you, this will
          refuse rather than take their balances with it.
        </p>
      </ConfirmDialog>

      <Modal open={step === "type"} title="Type to confirm" onClose={close}>
        <div className="stack">
          <p style={{ margin: 0 }}>
            This cannot be undone. Type <strong>{CONFIRM_PHRASE}</strong> to
            continue.
          </p>
          <div>
            <label htmlFor="wipeConfirm">Confirmation</label>
            <input
              id="wipeConfirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </div>
          {error && <p className="error">{error}</p>}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="secondary" type="button" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              className="danger"
              type="button"
              disabled={busy || typed !== CONFIRM_PHRASE}
              onClick={() => void wipe()}
            >
              {busy ? "Deleting…" : "Delete all data"}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
