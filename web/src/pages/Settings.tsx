import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { useAuth } from "../App.tsx";
import { CurrencySelect } from "../CurrencySelect.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { OnlineOnly, useOnline } from "../OnlineOnly.tsx";

/**
 * Account settings and API tokens.
 *
 * The API token list is how you connect splitwise-to-toshl: mint a token here,
 * paste it in as the "Splitwise API key", and point that app's proxy at this
 * server. See docs/SPLITWISE_COMPAT.md.
 */
export function Settings() {
  const { user, setUser } = useAuth();
  const online = useOnline();
  const navigate = useNavigate();
  const [tokens, setTokens] = useState<
    Array<{ id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>
  >([]);
  const [name, setName] = useState("splitwise-to-toshl");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);
  const [revokingBusy, setRevokingBusy] = useState(false);

  async function load() {
    try {
      setTokens((await api.listTokens()).tokens);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load tokens");
    }
  }

  useEffect(() => {
    if (online) void load();
  }, [online]);

  async function handleCreate(event: FormEvent) {
    event.preventDefault();
    try {
      const created = await api.createToken(name);
      // Shown once; the server only stores a hash.
      setFreshToken(created.token);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create token");
    }
  }

  return (
    <>
      <h1>Settings</h1>

      {error && <p className="error">{error}</p>}

      <div className="card">
        <div className="muted">Signed in as</div>
        <strong>
          {user?.firstName} {user?.lastName}
        </strong>
        <div className="muted">{user?.email ?? "Guest account (no email)"}</div>
      </div>

      <h2>Preferred currency</h2>
      <p className="muted">
        Used as the default when you add an expense, and as the target for on-screen conversions
        (settle-up equivalents and estimated totals). Nothing in the ledger changes: balances stay
        in the currency they were recorded in.
      </p>
      {user && (
        <div style={{ maxWidth: "16rem" }}>
          <label htmlFor="preferredCurrency">Currency</label>
          <OnlineOnly what="Changing your preferred currency">
            <CurrencySelect
              id="preferredCurrency"
              value={user.defaultCurrency}
              onChange={(code) => {
                void api
                  .updateMe({ defaultCurrency: code })
                  .then((result) => setUser(result.user))
                  .catch((err) =>
                    setError(err instanceof Error ? err.message : "Could not save preferred currency"),
                  );
              }}
            />
          </OnlineOnly>
        </div>
      )}

      <h2>Import from Splitwise</h2>
      <p className="muted">
        Bring your groups, friends and expense history across. You supply your own Splitwise API
        key; it is used for that import only and never stored. People are matched to existing
        accounts by email address, and you see exactly who matched before anything is written.
      </p>
      <OnlineOnly what="Importing from Splitwise">
        <Link to="/import">Start an import</Link>
      </OnlineOnly>

      <h2>API tokens</h2>
      <p className="muted">
        Use a token as the bearer credential for the Splitwise-compatible API at{" "}
        <code>/api/sw/v3.0</code>.
      </p>

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
              <OnlineOnly what="Revoking an API token">
                <button
                  className="secondary"
                  style={{ width: "auto" }}
                  onClick={() => setRevoking({ id: token.id, name: token.name })}
                >
                  Revoke
                </button>
              </OnlineOnly>
            )}
          </div>
        ))}
      </div>

      <form onSubmit={handleCreate} className="stack" style={{ marginTop: "1rem" }}>
        <div>
          <label htmlFor="tokenName">New token name</label>
          <input id="tokenName" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <OnlineOnly what="Creating an API token">
          <button type="submit">Create token</button>
        </OnlineOnly>
      </form>

      <ConfirmDialog
        open={revoking !== null}
        title={revoking ? `Revoke "${revoking.name}"?` : "Revoke token?"}
        confirmLabel="Revoke token"
        busyLabel="Revoking…"
        busy={revokingBusy}
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          setRevokingBusy(true);
          try {
            await api.revokeToken(revoking.id);
            await load();
            setRevoking(null);
          } finally {
            setRevokingBusy(false);
          }
        }}
      >
        <p style={{ margin: 0 }}>
          Anything using this token will stop working immediately. You cannot
          undo this.
        </p>
      </ConfirmDialog>

      <h2>Session</h2>
      <button
        className="secondary"
        style={{ width: "auto" }}
        onClick={() => {
          void api.logout().catch(() => {});
          setUser(null);
          navigate("/login");
        }}
      >
        Log out
      </button>
    </>
  );
}
