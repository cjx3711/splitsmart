/**
 * Add someone to a group — searchable friend list plus a new-placeholder form.
 *
 * Matches POST /api/v1/groups/:id/members: pick an existing friend, or create a
 * ghost with a name (and optional nickname) and add them in one step.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, displayName, type Friend } from "./api.ts";
import { Avatar, avatarFromRow } from "./Avatar.tsx";
import { HelpTip } from "./HelpTip.tsx";
import { Modal } from "./Modal.tsx";

function matchesFriend(friend: Friend, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    displayName(friend).toLowerCase().includes(q) ||
    friend.name.toLowerCase().includes(q) ||
    (friend.nickname?.toLowerCase().includes(q) ?? false)
  );
}

export function AddMemberDialog({
  open,
  onClose,
  groupId,
  existingIds,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  groupId: string;
  existingIds: string[];
  onAdded: () => void | Promise<void>;
}) {
  const [friends, setFriends] = useState<Friend[]>([]);
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setName("");
    setNickname("");
    setError(null);
    void api
      .listFriends()
      .then((r) => setFriends(r.friends))
      .catch(() => setFriends([]));
  }, [open]);

  const already = useMemo(() => new Set(existingIds), [existingIds]);
  const addable = useMemo(
    () => friends.filter((f) => !already.has(f.id)),
    [friends, already],
  );
  const filtered = useMemo(
    () => addable.filter((f) => matchesFriend(f, query)),
    [addable, query],
  );

  async function add(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onAdded();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add them");
    } finally {
      setBusy(false);
    }
  }

  async function handleNewPerson(event: FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const trimmedNick = nickname.trim();
    await add(() =>
      api.addGroupMember(groupId, {
        name: trimmedName,
        nickname: trimmedNick || undefined,
      }),
    );
  }

  return (
    <Modal open={open} title="Add someone" onClose={onClose}>
      <div className="stack">
        {error && <p className="error">{error}</p>}

        <div>
          <label htmlFor="memberSearch">From your friends</label>
          <input
            id="memberSearch"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name"
            autoComplete="off"
          />
        </div>

        {addable.length === 0 ? (
          <p className="muted">Everyone you know is already in this group.</p>
        ) : filtered.length === 0 ? (
          <p className="muted">No friends match that search.</p>
        ) : (
          <div className="list member-picker-list">
            {filtered.map((friend) => (
              <button
                key={friend.id}
                type="button"
                className="list-item member-picker-item"
                disabled={busy}
                onClick={() =>
                  void add(() => api.addGroupMember(groupId, { userId: friend.id }))
                }
              >
                <Avatar {...avatarFromRow(friend)} />
                <div className="list-item-body">
                  <div className="list-item-title">{displayName(friend)}</div>
                  {friend.nickname?.trim() && (
                    <div className="muted">{friend.name}</div>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        <form onSubmit={handleNewPerson} className="card stack member-new-form">
          <div className="label-with-help">
            <span className="eyebrow">Or a new name</span>
            <HelpTip label="About a new name">
              Creates a placeholder person. Send them a guest link below and they can use the group
              without an account.
            </HelpTip>
          </div>

          <div>
            <label htmlFor="newMemberName">Name</label>
            <input
              id="newMemberName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jordan Lee"
              autoComplete="name"
              maxLength={100}
            />
          </div>

          <div>
            <label htmlFor="newMemberNickname">Nickname</label>
            <input
              id="newMemberNickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder="Optional. Shown in lists instead of the full name."
              maxLength={40}
            />
          </div>

          <div>
            <button type="submit" className="inline" disabled={busy || !name.trim()}>
              {busy ? "Adding…" : "Add to group"}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
