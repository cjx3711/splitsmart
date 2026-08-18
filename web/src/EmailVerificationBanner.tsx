import { useState } from "react";
import { api, ApiError } from "./api.ts";
import { useAuth } from "./App.tsx";

/**
 * Nag bar for accounts with an unconfirmed address.
 *
 * Advisory by default: nothing is blocked. It exists because password reset
 * depends on a working address, so an unverified account is one typo away from
 * being unrecoverable.
 *
 * Renders nothing for guests, who have no email at all.
 */
export function EmailVerificationBanner() {
  const { user } = useAuth();
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  if (!user?.needsEmailVerification) return null;

  async function handleResend() {
    setStatus("sending");
    setMessage(null);
    try {
      const result = await api.resendVerification();
      setStatus("sent");
      setMessage(
        "alreadyVerified" in result && result.alreadyVerified
          ? "Already verified. Refresh the page."
          : "delivered" in result && result.delivered
            ? "Sent. Check your inbox."
            : // Mail isn't configured on this server; the link went to the
              // server log instead. Say so rather than implying an inbox.
              "Email isn't configured on this server. The link was written to the server log.",
      );
    } catch (err) {
      setStatus("error");
      setMessage(
        err instanceof ApiError ? err.message : "Couldn't send. Try again shortly.",
      );
    }
  }

  return (
    <div className="notice banner">
      <span style={{ flex: "1 1 240px" }}>
        {message ?? (
          <>
            Confirm <strong>{user.email}</strong> to secure your account.
          </>
        )}
      </span>
      {status !== "sent" && (
        <button
          className="secondary inline"
          onClick={handleResend}
          disabled={status === "sending"}
        >
          {status === "sending" ? "Sending…" : "Resend email"}
        </button>
      )}
    </div>
  );
}
