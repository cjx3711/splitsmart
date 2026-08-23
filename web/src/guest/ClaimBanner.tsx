/**
 * The persistent guest banner: create an account to keep this identity.
 *
 * It says what happens rather than just "sign up", because what happens is
 * unusual and worth being clear about: the placeholder you are using now is
 * merged into the account, so nothing you have already split moves.
 *
 * The button carries the link secret across to /app/claim in the URL. That is
 * the one place a secret is deliberately put back into a URL, and it is
 * unavoidable: /app is a different document, so it cannot read the guest
 * shell's in-memory state, and the claim endpoint needs the token to prove
 * these placeholders are yours to claim. /app/claim strips it out of the
 * address bar as soon as it has read it, the same way the landing page does.
 */
import { useState } from "react";
import { displayName } from "../api.ts";
import { useGuest } from "./GuestApp.tsx";
import { readGuestLink } from "./guestStorage.ts";

export function ClaimBanner() {
  const { session } = useGuest();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || session.needsPicker || !session.actingAs) return null;

  const secret = readGuestLink();
  if (!secret) return null;

  const target = `/app/claim?link=${encodeURIComponent(secret)}&person=${encodeURIComponent(session.actingAs.id)}`;

  return (
    <div className="banner guest-banner">
      <span>
        You are using this as <strong>{displayName(session.actingAs)}</strong>, with a link
        {session.issuedBy && (
          <>
            {" "}
            from <strong>{displayName(session.issuedBy)}</strong>
          </>
        )}
        {session.expiresAt && <> that expires {session.expiresAt.slice(0, 10)}</>}. Create an
        account to keep it: everything you have already split stays yours.
      </span>
      <span className="banner-actions">
        <a href={target} className="mkt-btn mkt-btn-sm">
          Make it mine
        </a>
        <button className="link" onClick={() => setDismissed(true)}>
          Not now
        </button>
      </span>
    </div>
  );
}
