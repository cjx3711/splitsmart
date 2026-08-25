/**
 * Two-button confirmation on top of Modal.
 *
 * Use for irreversible or hard-to-undo actions: revoking credentials, rotating
 * links, removing people, deleting an expense. New confirmations should use
 * this instead of copying the layout again.
 *
 * `cancelLabel` exists because "Cancel" is wrong for an OFFER rather than a
 * warning: when the question is "shall I also settle the groups?", declining
 * is a real answer that leaves the payment already made in place, and calling
 * it Cancel reads as if it would undo that.
 */
import type { ReactNode } from "react";
import { Modal } from "./Modal.tsx";

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  busyLabel,
  onConfirm,
  onClose,
  busy = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** The decline button. Say what declining does when it is not "nothing". */
  cancelLabel?: string;
  busyLabel?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
  busy?: boolean;
}) {
  return (
    <Modal open={open} title={title} onClose={onClose}>
      <div className="stack">
        {children}
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button type="button" onClick={() => void onConfirm()} disabled={busy}>
            {busy ? (busyLabel ?? `${confirmLabel}…`) : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
