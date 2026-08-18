/**
 * Name/icon editor in a modal. Shared by the friend and group screens; Settings
 * keeps the same fields inline because that page IS the editor, not a popup.
 *
 * The parent names the person and where to save; the dialog owns the draft,
 * busy, and error so those screens cannot drift on the save chrome.
 */
import { useEffect, useState, type FormEvent } from "react";
import { displayName } from "./api.ts";
import { Modal } from "./Modal.tsx";
import {
  PersonIdentityForm,
  draftFromPerson,
  identityPayload,
  type IdentityDraft,
} from "./PersonIdentityForm.tsx";

export function PersonIdentityDialog({
  open,
  person,
  onClose,
  onSave,
}: {
  open: boolean;
  person: {
    id: string;
    name: string;
    nickname?: string | null;
    iconLetters?: string | null;
    iconEmoji?: string | null;
    iconHue?: number | null;
    icon_letters?: string | null;
    icon_emoji?: string | null;
    icon_hue?: number | null;
  } | null;
  onClose: () => void;
  onSave: (id: string, payload: ReturnType<typeof identityPayload>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<IdentityDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && person) {
      setDraft(draftFromPerson(person));
      setError(null);
    }
  }, [open, person]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!person || !draft) return;
    const payload = identityPayload(draft);
    if (!payload.name) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(person.id, payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={person ? `Edit ${displayName(person)}` : "Edit name"}
      onClose={onClose}
    >
      {draft && person && (
        <form className="stack" onSubmit={(event) => void handleSubmit(event)}>
          {error && <p className="error">{error}</p>}
          <PersonIdentityForm id={person.id} value={draft} onChange={setDraft} />
          <button type="submit" disabled={busy || !draft.name.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      )}
    </Modal>
  );
}
