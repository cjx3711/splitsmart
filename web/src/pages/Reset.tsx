import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError } from "../api.ts";
import { Logo } from "../Logo.tsx";
import { PasswordField } from "../PasswordField.tsx";
import { useAuth } from "../App.tsx";
import { Skeleton } from "../Skeleton.tsx";

/** In-app paths only: `next` is a query string, so this is an open-redirect check. */
function inAppPath(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/**
 * Password reset: request a link, or choose a new password from one.
 *
 * `/reset` collects an email. The response is the same whether that address
 * has an account, so this page cannot be used to probe for one. `/reset/:token`
 * is the emailed (or server-logged) link; holding the token is the proof.
 */
export function Reset() {
  const { token } = useParams<{ token: string }>();
  if (token) return <ChoosePassword token={token} />;
  return <ForgotPassword />;
}

function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.forgotPassword(email);
      setSentTo(email);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  if (sentTo) {
    return (
      <div className="auth stack">
        <Logo size={30} />
        <h1>Check your inbox</h1>
        <p>
          If an account exists for <strong>{sentTo}</strong>, we sent a link to
          choose a new password.
        </p>
        <p className="field-hint">
          The link expires in 24 hours. Didn&apos;t get it? Check your spam
          folder, wait a minute and request another, or check the server log if
          this box has no mail provider.
        </p>
        <button
          className="link"
          onClick={() => {
            setSentTo(null);
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
      <h1>Reset password</h1>
      <p className="muted">We&apos;ll send a link to choose a new one.</p>

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
            autoFocus
          />
        </div>
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : "Send reset link"}
        </button>
      </form>

      <Link to="/login" className="link">
        Back to log in
      </Link>
    </div>
  );
}

type TokenState =
  | { kind: "working" }
  | { kind: "ready"; email: string }
  | { kind: "failed"; message: string };

function ChoosePassword({ token }: { token: string }) {
  const [searchParams] = useSearchParams();
  const next = searchParams.get("next");
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [state, setState] = useState<TokenState>({ kind: "working" });
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .lookupPasswordReset(token)
      .then((result) => {
        if (live) setState({ kind: "ready", email: result.email });
      })
      .catch((err) => {
        if (live) {
          setState({
            kind: "failed",
            message:
              err instanceof ApiError ? err.message : "That link could not be used.",
          });
        }
      });
    return () => {
      live = false;
    };
  }, [token]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { user } = await api.resetPassword(token, password);
      setUser(user);
      navigate(inAppPath(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reset the password.");
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "working") {
    return (
      <div className="auth stack">
        <Logo size={30} />
        <Skeleton kind="auth" label="Checking that link" />
      </div>
    );
  }

  if (state.kind === "failed") {
    return (
      <div className="auth stack">
        <Logo size={30} />
        <h1>Couldn&apos;t reset your password</h1>
        <p className="error">{state.message}</p>
        <p>
          <Link to="/reset">Request a new link</Link> or <Link to="/login">log in</Link>.
        </p>
      </div>
    );
  }

  return (
    <div className="auth stack">
      <Logo size={30} />
      <h1>Choose a new password</h1>
      <p className="muted">
        Resetting the password for <strong>{state.email}</strong>
      </p>

      <form onSubmit={handleSubmit} className="stack">
        {error && <p className="error">{error}</p>}
        <PasswordField
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          minLength={8}
          required
          autoComplete="new-password"
          autoFocus
          hint="At least 8 characters."
        />
        <button type="submit" disabled={busy}>
          {busy ? "Working…" : "Save password"}
        </button>
      </form>
    </div>
  );
}
