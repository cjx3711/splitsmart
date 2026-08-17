/**
 * Landing page for an emailed friend invite.
 *
 * The link carries the ghost account's recovery code, so opening it signs the
 * invitee straight in; the same path as POST /invite/recover. From there they
 * can set an email and password to turn the ghost into a real account, which
 * upgrades the row IN PLACE so no balance moves.
 *
 * Sitting on this screen without claiming is a valid outcome: they can look at
 * what they owe and set a password later.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { api } from "../api.ts";
import { Logo } from "../Logo.tsx";
import { useAuth } from "../App.tsx";

export function Accept() {
  const { code } = useParams<{ code: string }>();
  const { setUser } = useAuth();
  const navigate = useNavigate();

  const [state, setState] = useState<"working" | "signed_in" | "failed">("working");
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code) return;
    api
      .recover(code)
      .then(async (r) => {
        setName(r.user.firstName);
        const me = await api.me();
        setUser(me.user);
        setState("signed_in");
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : "That link is not valid.");
        setState("failed");
      });
  }, [code]);

  if (state === "working") return <p className="muted">Signing you in…</p>;

  if (state === "failed") {
    return (
      <div className="auth stack">
        <Logo size={30} />
        <p className="error">{error}</p>
        <p className="muted">
          The link may have already been used to set a password. Try logging in instead.
        </p>
        <Link to="/login">
          <button className="secondary">Go to log in</button>
        </Link>
      </div>
    );
  }

  return (
    <div className="auth stack">
      <Logo size={30} />
      <h1>You're in, {name}</h1>
      <p className="muted">
        You can use SplitSmart as a guest right now. Setting a password gives you a way back in
        from any device; everything you're already part of stays attached.
      </p>
      <ClaimForm onClaimed={() => navigate("/")} />
      <button className="secondary" onClick={() => navigate("/")}>
        Skip for now
      </button>
    </div>
  );
}

function ClaimForm({ onClaimed }: { onClaimed: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { setUser } = useAuth();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.claim(email, password);
      const me = await api.me();
      setUser(me.user);
      onClaimed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not set up your account");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="card stack">
      {error && <p className="error">{error}</p>}
      <div>
        <label htmlFor="claimEmail">Email</label>
        <input
          id="claimEmail"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </div>
      <div>
        <label htmlFor="claimPassword">Password</label>
        <input
          id="claimPassword"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
        />
        <p className="field-hint">At least 8 characters.</p>
      </div>
      <button type="submit" disabled={busy}>
        {busy ? "Setting up…" : "Set a password"}
      </button>
    </form>
  );
}
