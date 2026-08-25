/**
 * "That placeholder is me."
 *
 * Reached from the guest shell's banner, carrying the link secret. Four states,
 * and which one you land in is decided by the server, not guessed here:
 *
 *   not logged in    send them to register, and come straight back. The URL is
 *                    preserved through the round trip, secret included, because
 *                    without it there is nothing authorising the claim.
 *   already a member they are in this group as themselves. No picker: offering
 *                    to become someone else would be offering to impersonate.
 *   claimable        pick a placeholder, read what will happen, confirm.
 *   done             merged. Everything now hangs off the account.
 *
 * The confirm step is never skipped when shares will be combined. That part is
 * not undoable from the UI, so it is shown in words and counts first. See
 * docs/GUEST.md and src/domain/merge.ts.
 */
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api, displayName, type ClaimCandidates, type ClaimPreview } from "../api.ts";
import { Avatar } from "../Avatar.tsx";
import { useAuth, useSidebarRefresh } from "../App.tsx";
import { Skeleton } from "../Skeleton.tsx";

export function Claim() {
  const [params] = useSearchParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const refreshSidebar = useSidebarRefresh();

  // Read once, then get the secret out of the address bar. Same reasoning as
  // the guest landing page: screenshots and Referer headers should not carry
  // a credential around.
  const [linkToken] = useState(() => params.get("link") ?? "");
  const [suggested] = useState(() => params.get("person") ?? "");

  const [candidates, setCandidates] = useState<ClaimCandidates | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [preview, setPreview] = useState<ClaimPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!linkToken) return;
    window.history.replaceState(null, "", "/app/claim");
  }, [linkToken]);

  const load = useCallback(async () => {
    if (!linkToken || !user) return;
    try {
      const result = await api.claimCandidates(`link_${linkToken}`);
      setCandidates(result);
      if (result.status === "claimable") {
        const pick = result.candidates.some((p) => p.id === suggested)
          ? suggested
          : (result.candidates[0]?.id ?? null);
        setChosen(pick);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "That link is not valid.");
    }
  }, [linkToken, suggested, user]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!chosen || !linkToken) return;
    let live = true;
    setPreview(null);
    void api
      .claimPreview(`link_${linkToken}`, chosen)
      .then((p) => live && setPreview(p))
      .catch((err) => live && setError(err instanceof Error ? err.message : "Could not check."));
    return () => {
      live = false;
    };
  }, [chosen, linkToken]);

  if (loading) {
    return (
      <div className="auth stack">
        <Skeleton kind="auth" />
      </div>
    );
  }

  if (!linkToken) {
    return (
      <div className="auth stack">
        <h1>Nothing to claim</h1>
        <p className="muted">
          This page needs the guest link you were using. Open it again from the
          banner in the guest view.
        </p>
      </div>
    );
  }

  if (!user) return <SignInFirst linkToken={linkToken} person={suggested} />;

  if (done) {
    const destination =
      candidates?.status === "claimable" && candidates.group
        ? { label: candidates.group.name, path: `/groups/${candidates.group.id}` }
        : candidates?.status === "claimable" && candidates.counterpart
          ? { label: displayName(candidates.counterpart), path: `/friends/${candidates.counterpart.id}` }
          : null;

    return (
      <div className="auth stack">
        <h1>Link claimed</h1>
        <p className="muted">
          That person is you now. Everything they were part of is on this
          account, and the guest link that acted as them has stopped working.
        </p>
        <p style={{ display: "flex", gap: "0.5rem" }}>
          {destination && (
            <button onClick={() => navigate(destination.path)}>Open {destination.label}</button>
          )}
          <button className={destination ? "secondary" : undefined} onClick={() => navigate("/")}>
            Go to your dashboard
          </button>
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="auth stack">
        <h1>Claim</h1>
        <p className="error">{error}</p>
      </div>
    );
  }

  if (!candidates) {
    return (
      <div className="auth stack">
        <Skeleton kind="auth" label="Checking that link" />
      </div>
    );
  }

  if (candidates.status === "already_member") {
    return (
      <div className="auth stack">
        <h1>You are already in {candidates.group?.name}</h1>
        <p className="muted">
          You are in this group as yourself, so there is nothing to claim. A
          guest link would only let you act as somebody else.
        </p>
        <p>
          <button onClick={() => navigate(`/groups/${candidates.group?.id}`)}>
            Open {candidates.group?.name}
          </button>
        </p>
      </div>
    );
  }

  if (candidates.status === "none" || candidates.candidates.length === 0) {
    return (
      <div className="auth stack">
        <h1>Nobody left to claim</h1>
        <p className="muted">
          Everyone this link covers already has an account. If one of them
          should have been you, ask whoever shared the link.
        </p>
      </div>
    );
  }

  async function confirm() {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      await api.claim(`link_${linkToken}`, chosen);
      refreshSidebar();
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not finish the claim.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth stack">
      <h1>Which one is you?</h1>
      <p className="muted">
        Picking a name folds that person into your account. Nothing you owe or
        are owed changes.
      </p>

      <div className="list">
        {candidates.candidates.map((person) => {
          const name = displayName(person);
          return (
            <button
              key={person.id}
              type="button"
              className={person.id === chosen ? "list-item guest-pick selected" : "list-item guest-pick"}
              onClick={() => setChosen(person.id)}
              aria-pressed={person.id === chosen}
            >
              <Avatar
                id={person.id}
                name={person.name}
                nickname={person.nickname}
                iconLetters={person.iconLetters}
                iconEmoji={person.iconEmoji}
                iconHue={person.iconHue}
                iconPattern={person.iconPattern}
              />
              <div className="list-item-body">
                <div className="list-item-title">{name}</div>
              </div>
            </button>
          );
        })}
      </div>

      {preview && (
        <div className="notice stack">
          <ClaimSummary preview={preview} />
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button className="secondary" onClick={() => navigate("/")} disabled={busy}>
              Cancel
            </button>
            <button onClick={() => void confirm()} disabled={busy}>
              {busy
                ? "Working…"
                : preview.overlappingCount > 0
                  ? "Combine and claim"
                  : "Claim"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The sentence that has to be right.
 *
 * When the two of you are on the same bill, claiming ADDS the two shares
 * together. That is the honest description: nothing is re-split, nobody else's
 * cent moves, and the person confirming should know it before they press the
 * button rather than discover it in a balance later.
 */
function ClaimSummary({ preview }: { preview: ClaimPreview }) {
  const name = displayName(preview.person);
  const { overlappingCount, transferredCount, overlapping } = preview;

  return (
    <>
      {overlappingCount > 0 ? (
        <>
          <span>
            You and {name} are both on{" "}
            <strong>
              {overlappingCount} expense{overlappingCount === 1 ? "" : "s"}
            </strong>
            . Their shares will be combined into you.
            {transferredCount > 0 && (
              <>
                {" "}
                {transferredCount} other expense{transferredCount === 1 ? "" : "s"} will be
                retitled as you.
              </>
            )}
          </span>
          {/* A handful is worth reading; a hundred descriptions is a wall. */}
          {overlapping.length > 0 && overlappingCount <= 5 && (
            <ul className="breakdown">
              {overlapping.map((e) => (
                <li key={e.id}>
                  {e.description} · {e.date.slice(0, 10)}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <span>
          {transferredCount === 0 ? (
            <>{name} has nothing on the books yet; claiming just makes them you.</>
          ) : (
            <>
              {transferredCount} expense{transferredCount === 1 ? "" : "s"} will be retitled as
              you. Nothing is combined.
            </>
          )}
        </span>
      )}
      {preview.linkCount > 0 && (
        <span className="muted">
          The guest link{preview.linkCount === 1 ? "" : "s"} that acted as {name} will stop working.
        </span>
      )}
    </>
  );
}

/**
 * Create the account first, then come back.
 *
 * The whole query string is carried through the login round trip, so the
 * secret survives registration and the claim can be authorised on return. This
 * is the one flow: there is deliberately no "set a password on the placeholder"
 * shortcut. See docs/GUEST.md.
 */
function SignInFirst({ linkToken, person }: { linkToken: string; person: string }) {
  const next = `/claim?link=${encodeURIComponent(linkToken)}&person=${encodeURIComponent(person)}`;

  return (
    <div className="auth stack">
      <h1>Make it yours</h1>
      <p className="muted">
        Create an account and you will come straight back here to finish. The
        person you have been using becomes you; nothing you have split moves.
      </p>
      <p style={{ display: "flex", gap: "0.5rem" }}>
        <a href={`/app/login?register&next=${encodeURIComponent(next)}`} className="mkt-btn">
          Create an account
        </a>
        <a href={`/app/login?next=${encodeURIComponent(next)}`} className="mkt-btn mkt-btn-ghost">
          I already have one
        </a>
      </p>
    </div>
  );
}
