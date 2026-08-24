/**
 * Bearer tokens for /api/v1, for anything that is not this browser.
 *
 * Lived on Settings until the page got crowded; the credentials are the same,
 * they just have a room of their own next to the API docs.
 */
import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { HelpTip } from "../HelpTip.tsx";
import { NeedsConnection, OnlineOnly, useOnline } from "../OnlineOnly.tsx";

export function ApiTokens() {
  const online = useOnline();
  const [tokens, setTokens] = useState<
    Array<{
      id: string;
      name: string;
      created_at: string;
      last_used_at: string | null;
      revoked_at: string | null;
    }>
  >([]);
  const [name, setName] = useState("API client");
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
      setFreshToken(created.token);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create token");
    }
  }

  return (
    <>
      <Breadcrumbs trail={[{ label: "Settings", to: "/settings" }, { label: "API tokens" }]} />
      <h1 className="with-help">
        API tokens
        <HelpTip label="About API tokens">
          Use a token as the bearer credential for /api/v1. Cookie sessions are
          for this browser; tokens are for everything else.
        </HelpTip>
      </h1>

      <p className="muted">
        Scripts, another app, a recoded Splitwise client. Send the token as{" "}
        <code>Authorization: Bearer …</code>. See the{" "}
        <a href="/docs">API documentation</a>.
      </p>

      {error && <p className="error">{error}</p>}

      {!online && <NeedsConnection what="Managing API tokens" />}

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
          <input
            id="tokenName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="API client"
            required
          />
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
    </>
  );
}
