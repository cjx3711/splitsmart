/**
 * Postmark transport.
 *
 * A direct fetch against Postmark's REST API — no SDK. The surface we need is
 * one POST, and avoiding the dependency keeps the Docker image smaller and the
 * failure modes visible.
 *
 * DEGRADES GRACEFULLY BY DESIGN. If POSTMARK_SERVER_TOKEN or
 * POSTMARK_FROM_ADDRESS is missing, sending becomes a no-op that logs the
 * message (including any verification link) to the console instead of throwing.
 * This is deliberate for a self-hosted personal app: a misconfigured or
 * rate-limited mail provider must never prevent the server from booting, and in
 * local development you can complete the verification flow by copying the URL
 * out of the terminal.
 */
import { env, emailEnabled } from "../env.ts";

const POSTMARK_ENDPOINT = "https://api.postmarkapp.com/email";
const TIMEOUT_MS = 10_000;

export interface EmailMessage {
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string;
  /** Postmark stream. Transactional mail must not go out on a broadcast stream. */
  stream?: string;
}

export interface SendResult {
  delivered: boolean;
  /** Set when the send was skipped or failed; null on success. */
  reason: string | null;
  messageId?: string;
}

/**
 * Sends an email.
 *
 * NEVER THROWS. Callers are auth routes where a mail outage must not turn a
 * successful registration into a 500 — the account is already created and the
 * user can request another link. The result object carries the outcome for
 * logging; check `delivered` if you need to branch on it.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  if (!emailEnabled) {
    // Not an error: this is the documented unconfigured path.
    console.log(
      [
        "",
        "─".repeat(72),
        "EMAIL NOT SENT — Postmark is not configured.",
        `  To:      ${message.to}`,
        `  Subject: ${message.subject}`,
        "",
        message.textBody.trim(),
        "─".repeat(72),
        "",
      ].join("\n"),
    );
    return { delivered: false, reason: "postmark_not_configured" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(POSTMARK_ENDPOINT, {
      method: "POST",
      headers: {
        "X-Postmark-Server-Token": env.POSTMARK_SERVER_TOKEN!,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        From: env.POSTMARK_FROM_ADDRESS,
        To: message.to,
        Subject: message.subject,
        HtmlBody: message.htmlBody,
        TextBody: message.textBody,
        MessageStream: message.stream ?? env.POSTMARK_MESSAGE_STREAM,
      }),
      signal: controller.signal,
    });

    const body = (await response.json().catch(() => ({}))) as {
      ErrorCode?: number;
      Message?: string;
      MessageID?: string;
    };

    // Postmark signals failure with a non-2xx status OR a non-zero ErrorCode in
    // an otherwise-200 response. Both must be treated as failure.
    if (!response.ok || (body.ErrorCode ?? 0) !== 0) {
      const reason = `postmark_error_${body.ErrorCode ?? response.status}: ${body.Message ?? response.statusText}`;
      console.error(`Email to ${message.to} failed — ${reason}`);
      return { delivered: false, reason };
    }

    return { delivered: true, reason: null, messageId: body.MessageID };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? "postmark_timeout"
        : `postmark_unreachable: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`Email to ${message.to} failed — ${reason}`);
    return { delivered: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}
