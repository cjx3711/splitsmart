import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, ApiError } from "../api.ts";
import { useAuth } from "../App.tsx";
import { CurrencySelect } from "../CurrencySelect.tsx";
import { OnlineOnly, useOnline } from "../OnlineOnly.tsx";
import {
  PersonIdentityForm,
  draftFromPerson,
  identityPayload,
  type IdentityDraft,
} from "../PersonIdentityForm.tsx";
import { HelpTip } from "../HelpTip.tsx";
import { WipeLedgerButton } from "../WipeLedger.tsx";
import { DeleteAccountButton } from "../DeleteAccount.tsx";
import { ClearLocalDataButton } from "../ClearLocalData.tsx";
import { useSync } from "../sync/SyncProvider.tsx";
import { patchPerson, revertPerson } from "../sync/localFirst.ts";

/**
 * Account settings. Tokens, import, and the two delete actions used to share
 * this page; tokens have their own route and the deletes sit in a danger zone
 * at the bottom so they are hard to mix up with "log out" and "clear this device".
 */
export function Settings() {
  const { user, setUser } = useAuth();
  const { db, syncNow } = useSync();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<IdentityDraft | null>(null);
  const [identityBusy, setIdentityBusy] = useState(false);

  useEffect(() => {
    if (user) setIdentity(draftFromPerson(user));
  }, [user]);

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

      <h2 className="with-help">
        Export your data
        <HelpTip label="About exporting">
          A zip of CSV files covering this account: expenses, comments, groups, people, and your
          profile. Money is a decimal string with the currency in its own column, same as the
          download on the expenses screen. Nothing in the ledger changes.
        </HelpTip>
      </h2>
      <p className="muted">
        Download everything you can see as CSV files in a zip. Filtered downloads of just the
        current expense list still live on each expenses screen.
      </p>
      <OnlineOnly what="Exporting your data">
        <ExportDataButton onError={setError} />
      </OnlineOnly>

      <h2 className="with-help">
        API tokens
        <HelpTip label="About API tokens">
          Bearer credentials for /api/v1. Cookie sessions are for this browser; tokens are for
          scripts and other apps. The API documentation is linked from that page.
        </HelpTip>
      </h2>
      <Link to="/settings/tokens">Manage API tokens</Link>

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

      <section className="danger-zone">
        <h2>Danger zone</h2>
        <div className="danger-item">
          <h3>Delete all data</h3>
          <p className="muted">
            Permanently remove this account&apos;s groups, friends, expenses and guest links so
            you can import from Splitwise again. Your login is not deleted. Refuses if another
            real account still shares a group or expense with you.
          </p>
          <OnlineOnly what="Deleting this account's data">
            <WipeLedgerButton />
          </OnlineOnly>
        </div>
        <div className="danger-item">
          <h3>Delete account</h3>
          <p className="muted">
            Close this login. If other people with accounts still share groups or expenses with
            you, you become a placeholder they can still see — they can send you a guest link,
            and the history stays. If nobody else has an account on this data, everything is
            deleted, including this login.
          </p>
          <OnlineOnly what="Deleting this account">
            <DeleteAccountButton />
          </OnlineOnly>
        </div>
      </section>
    </>
  );
}

function ExportDataButton({ onError }: { onError: (message: string | null) => void }) {
  const online = useOnline();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    onError(null);
    try {
      const res = await fetch("/api/v1/export.zip", { credentials: "same-origin" });
      if (!res.ok) {
        let message = "Could not export your data";
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          // Non-JSON error body.
        }
        throw new ApiError(message, res.status);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filenameFromDisposition(res.headers.get("Content-Disposition"))
        ?? "splitsmart-export.zip";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not export your data");
    } finally {
      setBusy(false);
    }
  }

  return (
    <button type="button" className="secondary" style={{ width: "auto" }} disabled={!online || busy} onClick={() => void download()}>
      {busy ? "Preparing…" : "Download all data"}
    </button>
  );
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const match = /filename="([^"]+)"/.exec(header);
  return match?.[1] ?? null;
}
