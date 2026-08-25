/**
 * Name/icon editor in a modal. Shared by the friend and group screens; Settings
 * keeps the same fields inline because that page IS the editor, not a popup.
 *
 * On a placeholder, the dialog also edits the invite address. Saving stores
 * it; mail only goes out when the owner clicks Send invite.
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

export type IdentitySavePayload = ReturnType<typeof identityPayload> & {
  email?: string | null;
};

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
    email?: string | null;
    is_ghost?: number;
    isGhost?: boolean;
    iconLetters?: string | null;
    iconEmoji?: string | null;
    iconHue?: number | null;
    iconPattern?: import("../../src/domain/avatar-pattern.ts").AvatarPattern | string | null;
    icon_letters?: string | null;
    icon_emoji?: string | null;
    icon_hue?: number | null;
    icon_pattern?: import("../../src/domain/avatar-pattern.ts").AvatarPattern | string | null;
  } | null;
  onClose: () => void;
  onSave: (id: string, payload: IdentitySavePayload) => Promise<void>;
}) {
  const [draft, setDraft] = useState<IdentityDraft | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isGhost = person?.is_ghost === 1 || person?.isGhost === true;

  useEffect(() => {
    if (!open || !person) return;
    setDraft(draftFromPerson(person));
    setEmail(person.email ?? "");
    setError(null);
    // Seed when the dialog opens, not when a live query refreshes the person
    // under an in-progress edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, person?.id]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!person || !draft) return;
    const payload: IdentitySavePayload = identityPayload(draft);
    if (!payload.name) return;
    if (isGhost) payload.email = email.trim() || null;
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
      title={person ? `Edit ${displayName(person)}` : "Edit"}
      onClose={onClose}
    >
      {draft && person && (
        <form className="stack" onSubmit={(event) => void handleSubmit(event)}>
          {error && <p className="error">{error}</p>}
          <PersonIdentityForm
            id={person.id}
            value={draft}
            onChange={setDraft}
            inviteEmail={isGhost ? { value: email, onChange: setEmail } : undefined}
          />
          <button type="submit" disabled={busy || !draft.name.trim()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </form>
      )}
    </Modal>
  );
}
