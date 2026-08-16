/**
 * Friends list and the add-a-friend form.
 *
 * A friend needs only a name. The email is optional and does exactly one thing:
 * sends them an invite. The form says so, and says when the server can't send
 * one, rather than silently doing nothing.
 */
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, fullName, type Friend } from "../api.ts";
import { Ledger } from "../money.tsx";
import { Avatar } from "../Avatar.tsx";
import { useSidebarRefresh } from "../App.tsx";

export function Friends() {
  const [friends, setFriends] = useState<Friend[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshSidebar = useSidebarRefresh();

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
      </div>

      {error && <p className="error" style={{ marginBottom: "1rem" }}>{error}</p>}

      {friends === null ? (
        <p className="muted">Loading…</p>
      ) : friends.length === 0 ? (
        <p className="empty">No friends yet. Add someone below to start tracking what you split.</p>
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

      <AddFriend
        onAdded={() => {
          void load();
          refreshSidebar();
        }}
      />
    </>
  );
}

function AddFriend({ onAdded }: { onAdded: () => void }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<
    { name: string; existing: boolean; delivered: boolean; recoveryCode?: string } | null
  >(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setBusy(true);

    try {
      const response = await api.addFriend({
        firstName: firstName.trim(),
        lastName: lastName.trim() || undefined,
        email: email.trim() || undefined,
      });
      setResult({
        name: fullName(response.friend),
        existing: response.existingAccount,
        delivered: response.emailDelivered,
        recoveryCode: response.recoveryCode,
      });
      setFirstName("");
      setLastName("");
      setEmail("");
      onAdded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add friend");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Add a friend</h2>
      <form onSubmit={handleSubmit} className="card stack">
        {error && <p className="error">{error}</p>}
        {result && <AddFriendResult {...result} />}

        <div className="form-grid">
          <div>
            <label htmlFor="firstName">First name</label>
            <input
              id="firstName"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="Grace"
              required
            />
          </div>
          <div>
            <label htmlFor="lastName">Last name</label>
            <input
              id="lastName"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Ng"
            />
          </div>
        </div>

        <div>
          <label htmlFor="friendEmail">Email (optional)</label>
          <input
            id="friendEmail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="grace@example.com"
          />
          <p className="field-hint">
            Adding an email sends them an invite to join. If this server has no mail provider
            configured, the invite is written to the server log instead and you'll get a code to
            pass on yourself.
          </p>
        </div>

        <div>
          <button type="submit" disabled={busy || !firstName.trim()} className="inline">
            {busy ? "Adding…" : "Add friend"}
          </button>
        </div>
      </form>
    </>
  );
}

function AddFriendResult({
  name,
  existing,
  delivered,
  recoveryCode,
}: {
  name: string;
  existing: boolean;
  delivered: boolean;
  recoveryCode?: string;
}) {
  return (
    <div className="notice stack">
      <span>
        <strong>{name}</strong>{" "}
        {existing
          ? "already had an account and is now on your friends list."
          : "is on your friends list."}
      </span>
      {delivered && <span>The invite is on its way to their inbox.</span>}
      {recoveryCode && (
        <>
          <span>
            {delivered
              ? "Their sign-in code, in case the email goes astray:"
              : "No invite was emailed. Give them this sign-in code — it is shown only once:"}
          </span>
          <code>{recoveryCode}</code>
        </>
      )}
    </div>
  );
}
