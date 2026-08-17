/**
 * Modal dialog, built on native <dialog>.
 *
 * showModal() gives the focus trap, the inert background, the top layer and
 * Escape-to-close for free; all of which a hand-rolled div would have to
 * reimplement badly.
 *
 * IT DOES NOT CLOSE ON BACKDROP CLICK. That is the browser default for
 * <dialog> and it is the behaviour we want: these dialogs hold half-typed
 * expenses, and a stray click outside should not throw the form away. Do not
 * "fix" this by adding a backdrop click handler.
 *
 * Escape still closes, deliberately. A modal with no keyboard exit is a real
 * accessibility failure, and Escape is a deliberate keypress in a way that a
 * misplaced click is not.
 */
import { useEffect, useRef, type ReactNode } from "react";

export function Modal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Escape closes the dialog without going through React, so mirror the
  // browser's own `close` event back into state or the two drift apart.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const handleClose = () => onClose();
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  return (
    <dialog ref={ref} className="modal" aria-label={title}>
      <div className="modal-head">
        <h2 className="modal-title">{title}</h2>
        <button className="icon" onClick={onClose} aria-label="Close" type="button">
          ✕
        </button>
      </div>
      {/* Children are unmounted while closed so each open starts on a blank
          form rather than whatever was abandoned last time. */}
      <div className="modal-body">{open ? children : null}</div>
    </dialog>
  );
}
