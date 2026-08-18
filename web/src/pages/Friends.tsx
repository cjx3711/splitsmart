/**
 * Friends list. Adding one lives on its own page. See NewFriend.tsx.
 *
 * Read from the mirror, so the list and its balances are there with no network.
 * Adding and removing are online-only: both write a row the server owns, and a
 * placeholder person invented twice offline is two people where there should be
 * one, with every expense attached to the loser stranded (docs/OFFLINE.md).
 */
import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, displayName, type Friend } from "../api.ts";
import { Ledger } from "../money.tsx";
import { avatarFromRow } from "../Avatar.tsx";
import { FriendListItem } from "../FriendListItem.tsx";
import { useSidebarRefresh } from "../App.tsx";
import { useFriends, useMirrorReady } from "../localData.ts";
import { OnlineOnly } from "../OnlineOnly.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";

export function Friends() {
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Friend | null>(null);
  const [busy, setBusy] = useState(false);
  const refreshSidebar = useSidebarRefresh();
  const navigate = useNavigate();
  const friends = useFriends()?.friends ?? null;
  const ready = useMirrorReady();

  async function handleRemove(friend: Friend) {
    setError(null);
    setBusy(true);
    try {
      const result = await api.removeFriend(friend.id);
      refreshSidebar();
      if (result.stillVisible) {
        setError(
          `${displayName(friend)} is still listed because you share a group or an expense. Removing a friend never changes a balance.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove friend");
    } finally {
      setBusy(false);
      setRemoving(null);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Friends</h1>
        <div className="page-actions">
          <OnlineOnly what="Adding a friend">
            <button onClick={() => navigate("/friends/new")}>+ Add friend</button>
          </OnlineOnly>
        </div>
      </div>

      {error && <p className="error" style={{ marginBottom: "1rem" }}>{error}</p>}

      {friends === null ? (
        <p className="muted">Loading…</p>
      ) : friends.length === 0 ? (
        <p className="empty">
          {ready ? (
            <>
              No friends yet. <Link to="/friends/new">Add someone</Link> to start tracking what
              you split.
            </>
          ) : (
            "Waiting for the first sync."
          )}
        </p>
      ) : (
        <div className="list">
          {friends.map((friend) => (
            <FriendListItem
              key={friend.id}
              to={`/friends/${friend.id}`}
              avatar={avatarFromRow(friend)}
              title={displayName(friend)}
              subtitle={
                <span className="muted">
                  {friend.email ?? "No email"}
                  {friend.is_ghost === 1 && " · hasn't joined yet"}
                </span>
              }
              actions={
                friend.is_explicit ? (
                  <OnlineOnly what="Removing a friend">
                    <button
                      className="icon"
                      onClick={() => setRemoving(friend)}
                      aria-label={`Remove ${displayName(friend)}`}
                      title="Remove friend"
                    >
                      ✕
                    </button>
                  </OnlineOnly>
                ) : undefined
              }
            >
              <Ledger balances={friend.balances} />
              {!friend.is_explicit && (
                <span className="muted" title="From a shared group or expense">
                  shared
                </span>
              )}
            </FriendListItem>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={removing !== null}
        title={removing ? `Remove ${displayName(removing)}?` : "Remove friend?"}
        confirmLabel="Remove friend"
        busyLabel="Removing…"
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void handleRemove(removing);
        }}
      >
        <p style={{ margin: 0 }}>
          This only removes them from your explicit friends list. Balances do not
          change. If you still share a group or an expense, they will stay listed.
        </p>
      </ConfirmDialog>
    </>
  );
}
