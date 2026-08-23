/**
 * Native <dialog> plumbing, and the app chrome that sits on top of it.
 *
 * showModal() gives the focus trap, the inert background, the top layer and
 * Escape-to-close for free; all of which a hand-rolled div would have to
 * reimplement badly. Every popup in the app goes through this file so that
 * machinery cannot drift: Modal (forms, confirms) and Dialog (the marketing
 * lightbox, which wants different chrome).
 *
 * Modal DOES NOT CLOSE ON BACKDROP CLICK. That is the browser default for
 * <dialog> and it is the behaviour we want: these dialogs hold half-typed
 * expenses, and a stray click outside should not throw the form away. Do not
 * "fix" this by adding a backdrop click handler. The lightbox opts in via
 * `closeOnBackdrop` because a stray click there should dismiss, not trap.
 *
 * Escape still closes, deliberately. A modal with no keyboard exit is a real
 * accessibility failure, and Escape is a deliberate keypress in a way that a
 * misplaced click is not.
 */
import {
  useEffect,
  useRef,
  type DialogHTMLAttributes,
  type ReactNode,
} from "react";

export function Dialog({
  open,
  onClose,
  className,
  children,
  closeOnBackdrop = false,
  ...rest
}: {
  open: boolean;
  onClose: () => void;
  className?: string;
  children: ReactNode;
  closeOnBackdrop?: boolean;
} & Omit<DialogHTMLAttributes<HTMLDialogElement>, "open" | "className">) {
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Escape fires `close` without going through React, so bounce that back into
  // state or the two drift apart. dialog.close() fires the same event, including
  // when React already set open=false to move to another step — only notify the
  // parent when it still thinks this dialog is open.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    const handleClose = () => {
      if (openRef.current) onClose();
    };
    dialog.addEventListener("close", handleClose);
    return () => dialog.removeEventListener("close", handleClose);
  }, [onClose]);

  return (
    <dialog
      {...rest}
      ref={ref}
      className={className}
      onClick={
        closeOnBackdrop
          ? (event) => {
              rest.onClick?.(event);
              if (!event.defaultPrevented && event.target === event.currentTarget) {
                onClose();
              }
            }
          : rest.onClick
      }
    >
      {children}
    </dialog>
  );
}

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
  return (
    <Dialog open={open} onClose={onClose} className="modal" aria-label={title}>
      <div className="modal-head">
        <h2 className="modal-title">{title}</h2>
        <button className="icon" onClick={onClose} aria-label="Close" type="button">
          ✕
        </button>
      </div>
      {/* Children are unmounted while closed so each open starts on a blank
          form rather than whatever was abandoned last time. */}
      <div className="modal-body">{open ? children : null}</div>
    </Dialog>
  );
}
