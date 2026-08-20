import { useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api.ts";
import { Logo } from "../Logo.tsx";
import { useAuth } from "../App.tsx";
import { readLastUserId } from "../lastUser.ts";

/** In-app paths only: `next` is a query string, so this is an open-redirect check. */
function inAppPath(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/**
 * Log in or create an account. Two modes, one screen.
 *
 * There used to be a third, "recover", where a ghost typed a code to get back
 * into a placeholder account. That is gone: a guest's credential is the invite
 * URL itself, which the owner can revoke, and turning a placeholder into a real
 * account is a claim rather than a login. See docs/GUEST.md.
 *
 * `?next=` is honoured because the claim flow depends on it: the guest banner
 * sends people here to register and they have to come back to the same URL,
 * still carrying the link secret, or the claim cannot be authorised.
 */
export function Login() {
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<"login" | "register">(
    searchParams.has("register") ? "register" : "login",
  );
  const next = searchParams.get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { user, setUser, loading } = useAuth();
  const navigate = useNavigate();

  if (user) return <Navigate to={inAppPath(next)} replace />;
  // A returning visitor's profile is still loading from the mirror. Don't
  // flash the form; Navigate above fires as soon as the cached user appears.
  if (loading && readLastUserId()) return <p className="muted">Loading…</p>;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const { user } =
        mode === "login"
          ? await api.login(email, password)
          : await api.register({
              email,
              password,
              name,
              nickname: nickname.trim() || null,
            });
      setUser(user);
      navigate(inAppPath(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth stack">
      <Logo size={30} />
      <h1>{mode === "login" ? "Log in" : "Create account"}</h1>

      <form onSubmit={handleSubmit} className="stack">
        {error && <p className="error">{error}</p>}

        {mode === "register" && (
          <>
            <div>
              <label htmlFor="name">Name</label>
              <input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>
            <div>
              <label htmlFor="nickname">Nickname</label>
              <input
                id="nickname"
                value={nickname}
                onChange={(e) => setNickname(e.target.value)}
                maxLength={40}
                autoComplete="nickname"
                placeholder="Optional. Shown in lists instead of the full name."
              />
            </div>
          </>
        )}
        <div>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          {mode === "register" && <p className="field-hint">At least 8 characters.</p>}
        </div>

        <button type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "login" ? "Log in" : "Create account"}
        </button>
      </form>

      <div className="stack" style={{ marginTop: "0.5rem", alignItems: "flex-start" }}>
        <button className="link" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "Create an account" : "Log in instead"}
        </button>
        <p className="field-hint" style={{ margin: 0 }}>
          {mode === "register"
            ? "If a friend already imported you from Splitwise as a registered user, signing up with that same email claims that history. Sent a guest link? Create an account to claim that link."
            : "Sent a guest link? Open that link instead; it needs no account."}
        </p>
      </div>
    </div>
  );
}
