import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api.ts";
import { useAuth } from "../App.tsx";
import { CurrencySelect } from "../CurrencySelect.tsx";
import { ConfirmDialog } from "../ConfirmDialog.tsx";
import { OnlineOnly, useOnline } from "../OnlineOnly.tsx";
import {
  PersonIdentityForm,
  draftFromPerson,
  identityPayload,
  type IdentityDraft,
} from "../PersonIdentityForm.tsx";
import { HelpTip } from "../HelpTip.tsx";
import { WipeLedgerButton } from "../WipeLedger.tsx";
import { ClearLocalDataButton } from "../ClearLocalData.tsx";
import { useSync } from "../sync/SyncProvider.tsx";
import { patchPerson, revertPerson } from "../sync/localFirst.ts";

/**
 * Account settings and API tokens.
 *
 * Tokens are a bearer credential for `/api/v1`, for anything that is not this
 * browser: scripts, another app, a recoded Splitwise client.
 */
export function Settings() {
  const { user, setUser } = useAuth();
  const { db, syncNow } = useSync();
  const online = useOnline();
  const navigate = useNavigate();
  const [tokens, setTokens] = useState<
    Array<{ id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>
  >([]);
  const [name, setName] = useState("API client");
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; name: string } | null>(null);
  const [revokingBusy, setRevokingBusy] = useState(false);
  const [identity, setIdentity] = useState<IdentityDraft | null>(null);
  const [identityBusy, setIdentityBusy] = useState(false);

  useEffect(() => {
    if (user) setIdentity(draftFromPerson(user));
  }, [user]);

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
        <strong>{user?.nickname?.trim() || user?.name}</strong>
        {user?.nickname?.trim() && user?.name !== user.nickname.trim() && (
          <div className="muted">{user.name}</div>
        )}
        <div className="muted">{user?.email ?? "Guest account (no email)"}</div>
      </div>

      <h2 className="with-help">
        Name and icon
        <HelpTip label="About name and icon">
          One name, not first and last. A nickname is what other people see in lists. The image is
          coloured bands you can randomise or edit; letters and an emoji sit on top.
        </HelpTip>
      </h2>
      {user && identity && (
        <form
          className="card stack"
          onSubmit={(event) => {
            event.preventDefault();
            const payload = identityPayload(identity);
            if (!payload.name) return;
            setIdentityBusy(true);
            void (async () => {
              const previous = db ? await patchPerson(db, user.id, payload) : undefined;
              const previousUser = user;
              if (db) {
                setUser({
                  ...user,
                  name: payload.name,
                  nickname: payload.nickname,
                  iconLetters: payload.iconLetters,
                  iconEmoji: payload.iconEmoji,
                  iconHue: payload.iconHue,
                  iconPattern: payload.iconPattern,
                });
              }
              try {
                const result = await api.updateMe(payload);
                setUser(result.user);
                setIdentity(draftFromPerson(result.user));
                syncNow();
              } catch (err) {
                if (db && previous) await revertPerson(db, previous);
                setUser(previousUser);
                setError(err instanceof Error ? err.message : "Could not save name");
              } finally {
                setIdentityBusy(false);
              }
            })();
          }}
        >
          <OnlineOnly what="Changing your name and icon">
            <PersonIdentityForm id={user.id} value={identity} onChange={setIdentity} />
            <div>
              <button type="submit" className="inline" disabled={identityBusy || !identity.name.trim()}>
                {identityBusy ? "Saving…" : "Save name and icon"}
              </button>
            </div>
          </OnlineOnly>
        </form>
      )}

      <h2 className="with-help">
        Preferred currency
        <HelpTip label="About preferred currency">
          Used as the default when you add an expense, and as the target for on-screen conversions
          (settle-up equivalents and estimated totals). Nothing in the ledger changes: balances stay
          in the currency they were recorded in.
        </HelpTip>
      </h2>
      {user && (
        <div style={{ maxWidth: "16rem" }}>
          <label htmlFor="preferredCurrency">Currency</label>
          <OnlineOnly what="Changing your preferred currency">
            <CurrencySelect
              id="preferredCurrency"
              value={user.defaultCurrency}
              onChange={(code) => {
                void (async () => {
                  const previous = db
                    ? await patchPerson(db, user.id, { defaultCurrency: code })
                    : undefined;
                  const previousUser = user;
                  setUser({ ...user, defaultCurrency: code });
                  try {
                    const result = await api.updateMe({ defaultCurrency: code });
                    setUser(result.user);
                    syncNow();
                  } catch (err) {
                    if (db && previous) await revertPerson(db, previous);
                    setUser(previousUser);
                    setError(
                      err instanceof Error ? err.message : "Could not save preferred currency",
                    );
                  }
                })();
              }}
            />
          </OnlineOnly>
        </div>
      )}

      <h2 className="with-help">
        Import from Splitwise
        <HelpTip label="About importing from Splitwise">
          Bring your groups, friends and expense history across. You supply your own Splitwise API
          key; it is used for that import only and never stored. People are matched to existing
          accounts by email address, and you see exactly who matched before anything is written.
        </HelpTip>
      </h2>
      <OnlineOnly what="Importing from Splitwise">
        <Link to="/import">Start an import</Link>
      </OnlineOnly>

      {user?.isAdmin && (
        <>
          <h2 className="with-help">
            Admin
            <HelpTip label="About admin">
              Usage counts and database backups for this instance. Not a ledger browser: no
              amounts, titles, or link secrets.
            </HelpTip>
          </h2>
          <OnlineOnly what="Opening the admin panel">
            <button type="button" className="inline" onClick={() => navigate("/admin")}>
              Open admin
            </button>
          </OnlineOnly>
        </>
      )}

      <h2>Delete all data</h2>
      <p className="muted">
        Permanently remove this account&apos;s groups, friends, expenses and
        guest links so you can import from Splitwise again. Your login is not
        deleted.
      </p>
      <OnlineOnly what="Deleting this account's data">
        <WipeLedgerButton />
      </OnlineOnly>

      <h2 className="with-help">
        API tokens
        <HelpTip label="About API tokens">
          Use a token as the bearer credential for /api/v1. Cookie sessions are for this browser; tokens are for everything else.
        </HelpTip>
      </h2>

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

      <h2 className="with-help">
        This device
        <HelpTip label="About local data">
          The app keeps an offline copy of your data on this device so it still works without a
          connection. This only affects that copy - nothing on the server changes.
        </HelpTip>
      </h2>
      <OnlineOnly what="Clearing this device's local data">
        <ClearLocalDataButton />
      </OnlineOnly>

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
