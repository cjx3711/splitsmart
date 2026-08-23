/**
 * Add a friend. A friend needs only a name. The email is optional and does
 * exactly one thing: sends them an invite. The form says so, and says when
 * the server can't send one, rather than silently doing nothing.
 */
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, displayName } from "../api.ts";
import { useAuth, useSidebarRefresh } from "../App.tsx";
import { Breadcrumbs } from "../Breadcrumbs.tsx";
import { CopyLinkButton } from "../LinkPanel.tsx";
import { NeedsConnection, useOnline } from "../OnlineOnly.tsx";
import { HelpTip } from "../HelpTip.tsx";
import { useSync } from "../sync/SyncProvider.tsx";
import { ingestCreatedFriend } from "../sync/localFirst.ts";

export function NewFriend() {
  const refreshSidebar = useSidebarRefresh();
  const online = useOnline();
  const { user } = useAuth();
  const { db } = useSync();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<
    { id: string; name: string; existing: boolean; delivered: boolean; inviteUrl?: string } | null
  >(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setBusy(true);

    try {
      const response = await api.addFriend({
        name: name.trim(),
        email: email.trim() || undefined,
      });
      if (db && user) {
        await ingestCreatedFriend(db, user.id, response.friend, user.defaultCurrency);
      }
      setResult({
        id: response.friend.id,
        name: displayName(response.friend),
        existing: response.existingAccount,
        delivered: response.emailDelivered,
        inviteUrl: "inviteUrl" in response ? response.inviteUrl : undefined,
      });
      setName("");
      setEmail("");
      refreshSidebar();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add friend");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Breadcrumbs trail={[{ label: "Friends", to: "/friends" }, { label: "Add a friend" }]} />

      <div className="page-head">
        <h1>Add a friend</h1>
      </div>

      {!online ? (
        <NeedsConnection what="Adding a friend" />
      ) : (
      <form onSubmit={handleSubmit} className="card stack">
        {error && <p className="error">{error}</p>}
        {result && (
          <div className="notice stack">
            <span>
              <strong>{result.name}</strong>{" "}
              {result.existing
                ? "already had an account and is now on your friends list."
                : "is on your friends list."}
            </span>
            {result.delivered && <span>The invite is on its way to their inbox.</span>}
            {result.inviteUrl && (
              <>
                <span>
                  {result.delivered
                    ? "Their guest link, in case the email goes astray:"
                    : "No invite was emailed. Send them this link yourself:"}{" "}
                  <HelpTip label="About this invite link">
                    Expires in 3 months. You can always copy it again from their page. If it is
                    compromised, turn it off and create a new one.
                  </HelpTip>
                </span>
                <div className="link-url-row">
                  <code className="link-url">{result.inviteUrl}</code>
                  <CopyLinkButton url={result.inviteUrl} />
                </div>
              </>
            )}
            <span>
              <Link to={`/friends/${result.id}`}>View {result.name}</Link>
            </span>
          </div>
        )}

        <div>
          <label htmlFor="friendName">Name</label>
          <input
            id="friendName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Grace Ng"
            autoFocus
            required
            autoComplete="name"
          />
        </div>

        <div>
          <div className="label-with-help">
            <label htmlFor="friendEmail">Email (optional)</label>
            <HelpTip label="About the email">
              Adding an email sends them a guest link. If this server has no mail provider
              configured, the invite is written to the server log instead and the link is shown
              here for you to pass on yourself.
            </HelpTip>
          </div>
          <input
            id="friendEmail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="grace@example.com"
          />
        </div>

        <div>
          <button type="submit" disabled={busy || !name.trim()} className="inline">
            {busy ? "Adding…" : "Add friend"}
          </button>
        </div>
      </form>
      )}
    </>
  );
}
