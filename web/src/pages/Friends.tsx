/**
 * Friends list. Adding one lives on its own page - see NewFriend.tsx.
 */
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fullName, type Friend } from "../api.ts";
import { Ledger } from "../money.tsx";
import { Avatar } from "../Avatar.tsx";
import { useSidebarRefresh } from "../App.tsx";

export function Friends() {
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshSidebar = useSidebarRefresh();
  const navigate = useNavigate();

  async function load() {
    try {
      const data = await api.listFriends();
      setFriends(data.friends);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load friends");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleRemove(friend: Friend) {
    setError(null);
    try {
      const result = await api.removeFriend(friend.id);
      await load();
      refreshSidebar();
      if (result.stillVisible) {
        setError(
          `${fullName(friend)} is still listed because you share a group or an expense. Removing a friend never changes a balance.`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove friend");
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Friends</h1>
        <div className="page-actions">
          <button onClick={() => navigate("/friends/new")}>+ Add friend</button>
        </div>
      </div>

      {error && <p className="error" style={{ marginBottom: "1rem" }}>{error}</p>}

      {friends === null ? (
        <p className="muted">Loading…</p>
      ) : friends.length === 0 ? (
        <p className="empty">
          No friends yet. <Link to="/friends/new">Add someone</Link> to start tracking what you
          split.
        </p>
      ) : (
        <div className="list">
          {friends.map((friend) => (
            <div key={friend.id} className="list-item">
              <Avatar id={friend.id} name={fullName(friend)} />
              <Link
                to={`/friends/${friend.id}`}
                className="list-item-body"
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div className="list-item-title">{fullName(friend)}</div>
                <div className="muted">
                  {friend.email ?? "No email"}
                  {friend.is_ghost === 1 && " · hasn't joined yet"}
                </div>
              </Link>
              <Ledger balances={friend.balances} />
              {friend.is_explicit ? (
                <button
                  className="icon"
                  onClick={() => void handleRemove(friend)}
                  aria-label={`Remove ${fullName(friend)}`}
                  title="Remove friend"
                >
                  ✕
                </button>
              ) : (
                <span className="muted" title="From a shared group or expense">
                  shared
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
