import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api.ts";
import { Logo } from "../Logo.tsx";
import { PasswordField } from "../PasswordField.tsx";
import { useAuth } from "../App.tsx";
import { readLastUserId } from "../lastUser.ts";

/** In-app paths only: `next` is a query string, so this is an open-redirect check. */
function inAppPath(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
}

function tokenFromVerifyUrl(verifyUrl: string): string {
  try {
    const parts = new URL(verifyUrl).pathname.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? "";
  } catch {
    return "";
  }
}

function pathFromVerifyUrl(verifyUrl: string, fallbackNext: string | null): string {
  try {
    const url = new URL(verifyUrl);
    const path = url.pathname.replace(/^\/app/, "") || "/";
    const next = url.searchParams.get("next") ?? fallbackNext;
    return next ? `${path}?next=${encodeURIComponent(next)}` : path;
  } catch {
    const token = tokenFromVerifyUrl(verifyUrl);
    return fallbackNext
      ? `/verify/${token}?next=${encodeURIComponent(fallbackNext)}`
      : `/verify/${token}`;
  }
}

/**
 * Log in or start creating an account. Two modes, one screen.
 *
 * Register is email-first: this page only collects the address. Completing
 * the account (name, password) happens on `/verify/:token` after the
 * verification link is either returned here (mail not required) or opened
 * from the inbox.
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inboxEmail, setInboxEmail] = useState<string | null>(null);

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
      if (mode === "login") {
        const { user } = await api.login(email, password);
        setUser(user);
        navigate(inAppPath(next));
        return;
      }

      const result = await api.signup({
        email,
        ...(next ? { next } : {}),
      });
      if (result.verifyUrl) {
        navigate(pathFromVerifyUrl(result.verifyUrl, next));
        return;
      }
      setInboxEmail(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  if (inboxEmail) {
    return (
      <div className="auth stack">
        <Logo size={30} />
        <h1>Check your inbox</h1>
        <p>
          We sent a link to <strong>{inboxEmail}</strong>. Open it to choose a
          name and password.
        </p>
        <p className="field-hint">
          The link expires in 24 hours. Didn&apos;t get it? Wait a minute and
          request another from this page.
        </p>
        <button
          className="link"
          onClick={() => {
            setInboxEmail(null);
            setError(null);
          }}
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <div className="auth stack">
      <Logo size={30} />
      <h1>{mode === "login" ? "Log in" : "Create account"}</h1>

      <form onSubmit={handleSubmit} className="stack">
        {error && <p className="error">{error}</p>}

        <div>
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />
        </div>
        {mode === "login" && (
          <PasswordField
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
            autoComplete="current-password"
          />
        )}

        <button type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "login" ? "Log in" : "Continue"}
        </button>
      </form>

      <div className="stack" style={{ marginTop: "0.5rem", alignItems: "flex-start" }}>
        {mode === "login" && (
          <Link to="/reset" className="link">
            Forgot password?
          </Link>
        )}
        <button
          className="link"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError(null);
            setInboxEmail(null);
          }}
        >
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
