/**
 * Adding someone to a group.
 *
 * This screen used to not exist, because a group grew by people opening the
 * invite link and creating themselves. That is gone (docs/GUEST.md): opening a
 * link no longer creates a person, so somebody with an account has to put the
 * names there, and guests pick among them.
 *
 * Two ways in, matching POST /api/v1/groups/:id/members:
 *
 *   an existing friend      already a row in `users`, already has history
 *   a new placeholder name  a ghost created here, reachable by a guest link
 */
import { useEffect, useState, type FormEvent } from "react";
import { api, displayName, type Friend } from "./api.ts";

export function AddMemberForm({
  groupId,
  existingIds,
  onAdded,
}: {
  groupId: string;
  existingIds: string[];
  onAdded: () => void | Promise<void>;
}) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .listFriends()
      .then((r) => setFriends(r.friends))
      .catch(() => setFriends([]));
  }, []);

  const already = new Set(existingIds);
  const addable = friends.filter((f) => !already.has(f.id));

  async function add(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add them");
    } finally {
      setBusy(false);
    }
  }

  async function handleNewPerson(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    await add(() =>
      api.addGroupMember(groupId, { name: trimmed }),
    );
    setName("");
  }

  return (
    <div className="card stack">
      <span className="eyebrow">Add someone</span>
      {error && <p className="error">{error}</p>}

      {addable.length > 0 && (
        <div>
          <label>From your friends</label>
          <div className="chip-row">
            {addable.map((f) => (
              <button
                key={f.id}
                type="button"
                className="secondary inline"
                disabled={busy}
                onClick={() => void add(() => api.addGroupMember(groupId, { userId: f.id }))}
              >
                + {displayName(f)}
              </button>
            ))}
          </div>
        </div>
      )}

      <form onSubmit={handleNewPerson} className="stack">
        <div>
          <label htmlFor="newMemberName">Or a new name</label>
          <input
            id="newMemberName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jordan"
          />
          <p className="field-hint">
            Creates a placeholder person. Send them a guest link below and they
            can use the group without an account.
          </p>
        </div>
        <div>
          <button type="submit" className="inline" disabled={busy || !name.trim()}>
            {busy ? "Adding…" : "Add to group"}
          </button>
        </div>
      </form>
    </div>
  );
}
