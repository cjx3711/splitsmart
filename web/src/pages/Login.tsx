import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { Logo } from "../Logo.tsx";
import { useAuth } from "../App.tsx";

/** Login, registration, and ghost recovery — three modes, one screen. */
export function Login() {
  const [mode, setMode] = useState<"login" | "register" | "recover">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { setUser } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      if (mode === "login") {
        const { user } = await api.login(email, password);
        setUser(user);
      } else if (mode === "register") {
        const { user } = await api.register({ email, password, firstName });
        setUser(user);
      } else {
        await api.recover(recoveryCode);
        const { user } = await api.me();
        setUser(user);
      }
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth stack">
      <Logo size={30} />
      <h1>
        {mode === "login" ? "Log in" : mode === "register" ? "Create account" : "Recover access"}
      </h1>

      <form onSubmit={handleSubmit} className="stack">
        {error && <p className="error">{error}</p>}

        {mode === "recover" ? (
          <div>
            <label htmlFor="recovery">Recovery code</label>
            <input
              id="recovery"
              value={recoveryCode}
              onChange={(e) => setRecoveryCode(e.target.value)}
              placeholder="K7M2-9QXR-4TWP"
              required
            />
            <p className="field-hint">
              The code you were shown when you joined a group, or the one in a friend invite.
            </p>
          </div>
        ) : (
          <>
            {mode === "register" && (
              <div>
                <label htmlFor="firstName">Name</label>
                <input
                  id="firstName"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                />
              </div>
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
          </>
        )}

        <button type="submit" disabled={busy}>
          {busy ? "Working…" : mode === "login" ? "Log in" : mode === "register" ? "Create account" : "Recover"}
        </button>
      </form>

      <div className="stack" style={{ marginTop: "0.5rem", alignItems: "flex-start" }}>
        {mode !== "register" && (
          <button className="link" onClick={() => setMode("register")}>
            Create an account
          </button>
        )}
        {mode !== "login" && (
          <button className="link" onClick={() => setMode("login")}>
            Log in instead
          </button>
        )}
        {mode !== "recover" && (
          <button className="link" onClick={() => setMode("recover")}>
            Use a recovery code
          </button>
        )}
      </div>
    </div>
  );
}
