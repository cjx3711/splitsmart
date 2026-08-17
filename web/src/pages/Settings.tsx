import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.ts";
import { useAuth } from "../App.tsx";

/**
 * Account settings and API tokens.
 *
 * The API token list is how you connect splitwise-to-toshl: mint a token here,
 * paste it in as the "Splitwise API key", and point that app's proxy at this
 * server. See docs/SPLITWISE_COMPAT.md.
 */
export function Settings() {
  const { user } = useAuth();
  const [tokens, setTokens] = useState<
    Array<{ id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>
  >([]);
  const [name, setName] = useState("splitwise-to-toshl");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setTokens((await api.listTokens()).tokens);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tokens");
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    try {
      const created = await api.createToken(name);
      // Shown once — the server only stores a hash.
      setFreshToken(created.token);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create token");
    }
  }

  return (
    <>
      <h1>Settings</h1>

      <div className="card">
        <div className="muted">Signed in as</div>
        <strong>
          {user?.firstName} {user?.lastName}
        </strong>
        <div className="muted">{user?.email ?? "Guest account (no email)"}</div>
      </div>

      <h2>Import from Splitwise</h2>
      <p className="muted">
        Bring your groups, friends and expense history across. You supply your own Splitwise API
        key; it is used for that import only and never stored. People are matched to existing
        accounts by email address, and you see exactly who matched before anything is written.
      </p>
      <Link to="/import">Start an import</Link>

      <h2>API tokens</h2>
      <p className="muted">
        Use a token as the bearer credential for the Splitwise-compatible API at{" "}
        <code>/api/sw/v3.0</code>.
      </p>

      {error && <p className="error">{error}</p>}

      {freshToken && (
        <div className="notice stack">
          <strong>Copy this token now</strong>
          <p style={{ margin: 0 }}>It will not be shown again.</p>
          <code>{freshToken}</code>
          <button className="secondary" onClick={() => void navigator.clipboard.writeText(freshToken)}>
            Copy token
          </button>
        </div>
      )}

      <div className="stack" style={{ marginTop: "0.75rem" }}>
        {tokens.map((token) => (
          <div key={token.id} className="card row">
            <div>
              <strong>{token.name}</strong>
              <div className="muted">
                created {token.created_at.split(" ")[0]}
                {token.last_used_at ? ` · last used ${token.last_used_at.split("T")[0]}` : " · never used"}
                {token.revoked_at ? " · revoked" : ""}
              </div>
            </div>
            {!token.revoked_at && (
              <button
                className="secondary"
                style={{ width: "auto" }}
                onClick={async () => {
                  await api.revokeToken(token.id);
                  await load();
                }}
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>

      <form onSubmit={handleCreate} className="stack" style={{ marginTop: "1rem" }}>
        <div>
          <label htmlFor="tokenName">New token name</label>
          <input id="tokenName" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <button type="submit">Create token</button>
      </form>
    </>
  );
}
