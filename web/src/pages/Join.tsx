import { useEffect, useState, type FormEvent } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { Logo } from "../Logo.tsx";
import { useAuth } from "../App.tsx";

/**
 * The invite-link join page.
 *
 * Anyone with the link can create a ghost account here; no email, no password.
 * The recovery code shown afterwards is the ONLY way back into that account
 * from another device, so it is displayed on a blocking step rather than a
 * toast the user can miss.
 */
export function Join() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const { setUser } = useAuth();

  const [preview, setPreview] = useState<{
    name: string;
    memberCount: number;
    memberNames: string[];
  } | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<{ recoveryCode: string; groupId: number } | null>(null);

  useEffect(() => {
    if (!token) return;
    api
      .previewInvite(token)
      .then((r) => setPreview(r.group))
      .catch((err) => setError(err instanceof Error ? err.message : "Invalid invite link"));
  }, [token]);

  async function handleJoin(event: FormEvent) {
    event.preventDefault();
    if (!token || !displayName.trim()) return;

    setBusy(true);
    setError(null);
    try {
      const result = await api.joinInvite(token, displayName.trim());
      const me = await api.me();
      setUser(me.user);
      setJoined({ recoveryCode: result.recoveryCode, groupId: result.group.id });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not join");
    } finally {
      setBusy(false);
    }
  }

  if (joined) {
    return (
      <div className="auth stack">
        <Logo size={30} />
        <h1>You're in</h1>
        <div className="notice stack">
          <strong>Save your recovery code</strong>
          <p style={{ margin: 0 }}>
            This is the only way to get back into your account from another device or
            browser. It will not be shown again.
          </p>
          <code style={{ fontSize: "1.25rem" }}>{joined.recoveryCode}</code>
        </div>
        <p style={{ marginTop: "1rem" }}>
          <button onClick={() => navigate(`/groups/${joined.groupId}`)}>
            I've saved it, continue
          </button>
        </p>
      </div>
    );
  }

  if (error && !preview) {
    return (
      <div className="auth stack">
        <Logo size={30} />
        <h1>Invite link</h1>
        <p className="error">{error}</p>
      </div>
    );
  }

  if (!preview) return <p className="muted">Loading…</p>;

  return (
    <div className="auth stack">
      <Logo size={30} />
      <h1>Join {preview.name}</h1>
      <p className="muted">
        {preview.memberCount} member{preview.memberCount === 1 ? "" : "s"}
        {preview.memberNames.length > 0 && `: ${preview.memberNames.join(", ")}`}
      </p>

      <form onSubmit={handleJoin} className="stack">
        {error && <p className="error">{error}</p>}
        <div>
          <label htmlFor="displayName">Your name</label>
          <input
            id="displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Jordan"
            required
          />
          <p className="field-hint">
            No email or password needed. You'll get a recovery code to save.
          </p>
        </div>
        <button type="submit" disabled={busy || !displayName.trim()}>
          {busy ? "Joining…" : "Join group"}
        </button>
      </form>
    </div>
  );
}
