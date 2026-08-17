/**
 * Add a friend. A friend needs only a name. The email is optional and does
 * exactly one thing: sends them an invite. The form says so, and says when
 * the server can't send one, rather than silently doing nothing.
 */
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, fullName } from "../api.ts";
import { useSidebarRefresh } from "../App.tsx";

export function NewFriend() {
  const refreshSidebar = useSidebarRefresh();

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<
    { id: number; name: string; existing: boolean; delivered: boolean; recoveryCode?: string } | null
  >(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    setBusy(true);

    try {
      const response = await api.addFriend({
        firstName: firstName.trim(),
        lastName: lastName.trim() || undefined,
        email: email.trim() || undefined,
      });
      setResult({
        id: response.friend.id,
        name: fullName(response.friend),
        existing: response.existingAccount,
        delivered: response.emailDelivered,
        recoveryCode: response.recoveryCode,
      });
      setFirstName("");
      setLastName("");
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
      <div className="page-head">
        <h1>Add a friend</h1>
      </div>

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
            {result.recoveryCode && (
              <>
                <span>
                  {result.delivered
                    ? "Their sign-in code, in case the email goes astray:"
                    : "No invite was emailed. Give them this sign-in code - it is shown only once:"}
                </span>
                <code>{result.recoveryCode}</code>
              </>
            )}
            <span>
              <Link to={`/friends/${result.id}`}>View {result.name}</Link>
            </span>
          </div>
        )}

        <div className="form-grid">
          <div>
            <label htmlFor="firstName">First name</label>
            <input
              id="firstName"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="Grace"
              autoFocus
              required
            />
          </div>
          <div>
            <label htmlFor="lastName">Last name</label>
            <input
              id="lastName"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Ng"
            />
          </div>
        </div>

        <div>
          <label htmlFor="friendEmail">Email (optional)</label>
          <input
            id="friendEmail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="grace@example.com"
          />
          <p className="field-hint">
            Adding an email sends them an invite to join. If this server has no mail provider
            configured, the invite is written to the server log instead and you'll get a code to
            pass on yourself.
          </p>
        </div>

        <div>
          <button type="submit" disabled={busy || !firstName.trim()} className="inline">
            {busy ? "Adding…" : "Add friend"}
          </button>
        </div>
      </form>
    </>
  );
}
