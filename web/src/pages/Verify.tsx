import { useEffect, useState, useRef, type FormEvent } from "react";
import { useParams, useSearchParams, Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api.ts";
import { useAuth } from "../App.tsx";
import { Logo } from "../Logo.tsx";
import { PasswordField } from "../PasswordField.tsx";

type State =
  | { kind: "working" }
  | { kind: "signup"; email: string; nextPath: string | null }
  | { kind: "verified" }
  | { kind: "failed"; message: string };

/** In-app paths only: `next` is a query string, so this is an open-redirect check. */
function inAppPath(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/**
 * Landing page for the emailed (or client-returned) verification link.
 *
 * Two outcomes:
 *   pending_signup  the address is proven; collect name + password and create
 *                   the account. Works signed-out; the link is the proof.
 *   verified        an existing account confirmed its address.
 */
export function Verify() {
  const { token } = useParams<{ token: string }>();
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next");
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<State>({ kind: "working" });
  const [name, setName] = useState("");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // StrictMode double-invokes effects in dev. Without this guard the token is
  // posted twice. Harmless (lookup is idempotent), but it makes the network
  // log confusing.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    api
      .verifyEmail(token)
      .then(async (result) => {
        if ("status" in result && result.status === "pending_signup" && "email" in result) {
          const fromToken =
            "next" in result && typeof result.next === "string" ? result.next : null;
          setState({
            kind: "signup",
            email: result.email as string,
            nextPath: next ?? fromToken,
          });
          return;
        }
        setState({ kind: "verified" });
        try {
          setUser((await api.me()).user);
        } catch {
          // Not signed in on this device; verification still succeeded.
        }
      })
      .catch((err) => {
        setState({
          kind: "failed",
          message:
            err instanceof ApiError ? err.message : "That link could not be confirmed.",
        });
      });
  }, [token, setUser]);

  async function handleRegister(event: FormEvent) {
    event.preventDefault();
    if (!token) return;
    setError(null);
    setBusy(true);
    try {
      const { user: created } = await api.register({
        token,
        password,
        name,
        nickname: nickname.trim() || null,
      });
      setUser(created);
      navigate(inAppPath(state.kind === "signup" ? (state.nextPath ?? next) : next));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the account.");
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "working") return <p className="muted">Confirming your email…</p>;

  if (state.kind === "signup") {
    return (
      <div className="auth stack">
        <Logo size={30} />
        <h1>Finish creating your account</h1>
        <p className="muted">
          Signing up as <strong>{state.email}</strong>
        </p>

        <form onSubmit={handleRegister} className="stack">
          {error && <p className="error">{error}</p>}
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
          <PasswordField
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
            autoComplete="new-password"
            hint="At least 8 characters."
          />
          <button type="submit" disabled={busy}>
            {busy ? "Working…" : "Create account"}
          </button>
        </form>
      </div>
    );
  }

  if (state.kind === "verified") {
    return (
      <>
        <h1>Email confirmed</h1>
        <p className="notice">Your email address is verified.</p>
        <p style={{ marginTop: "1rem" }}>
          <Link to={user ? "/" : "/login"}>{user ? "Go to your groups" : "Log in"}</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <h1>Couldn&apos;t confirm your email</h1>
      <p className="error">{state.message}</p>
      {user ? (
        <p style={{ marginTop: "1rem" }}>
          You&apos;re signed in. Request a fresh link from{" "}
          <Link to="/settings">Settings</Link>.
        </p>
      ) : (
        <p style={{ marginTop: "1rem" }}>
          <Link to="/login?register">Request a new link</Link> or{" "}
          <Link to="/login">log in</Link>.
        </p>
      )}
    </>
  );
}
