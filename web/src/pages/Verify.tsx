import { useEffect, useState, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { api, ApiError } from "../api.ts";
import { useAuth } from "../App.tsx";

type State =
  | { kind: "working" }
  | { kind: "verified" }
  | { kind: "failed"; message: string };

/**
 * Landing page for the emailed verification link.
 *
 * Works signed-out; the link commonly gets opened in a different browser from
 * the one that registered, so holding the token is the proof.
 */
export function Verify() {
  const { token } = useParams<{ token: string }>();
  const { user, setUser } = useAuth();
  const [state, setState] = useState<State>({ kind: "working" });

  // StrictMode double-invokes effects in dev. Without this guard the token is
  // consumed twice. Harmless (the second call is idempotent), but it makes the
  // network log confusing.
  const attempted = useRef(false);

  useEffect(() => {
    if (!token || attempted.current) return;
    attempted.current = true;

    api
      .verifyEmail(token)
      .then(async () => {
        setState({ kind: "verified" });
        // Refresh the session so the banner disappears without a reload.
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

  if (state.kind === "working") return <p className="muted">Confirming your email…</p>;

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
      <h1>Couldn't confirm your email</h1>
      <p className="error">{state.message}</p>
      {user ? (
        <p style={{ marginTop: "1rem" }}>
          You're signed in. Request a fresh link from{" "}
          <Link to="/settings">Settings</Link>.
        </p>
      ) : (
        <p style={{ marginTop: "1rem" }}>
          <Link to="/login">Log in</Link> and request a new link.
        </p>
      )}
    </>
  );
}
