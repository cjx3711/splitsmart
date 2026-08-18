/**
 * Two-button confirmation on top of Modal.
 *
 * Use for irreversible or hard-to-undo actions: revoking credentials, rotating
 * links, removing people, deleting an expense. New confirmations should use
 * this instead of copying the layout again.
 */
import type { ReactNode } from "react";
import { Modal } from "./Modal.tsx";

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  busyLabel,
  onConfirm,
  onClose,
  busy = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
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
            Cancel
          </button>
          <button type="button" onClick={() => void onConfirm()} disabled={busy}>
            {busy ? (busyLabel ?? `${confirmLabel}…`) : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
