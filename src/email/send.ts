/**
 * Mail transport.
 *
 * A direct fetch against Resend or Postmark; no SDK. The surface we need is
 * one POST, and avoiding the dependency keeps the Docker image smaller and the
 * failure modes visible. Which provider is used is decided once at boot from
 * the environment: a complete Resend pair, a complete Postmark pair, or
 * neither. Both at once is a boot error (see resolveEmailProvider).
 *
 * DEGRADES GRACEFULLY BY DESIGN. If no provider is configured, sending becomes
 * a no-op that logs the message (including any verification link) to the
 * console instead of throwing. This is deliberate for a self-hosted personal
 * app: a misconfigured or rate-limited mail provider must never prevent the
 * server from booting, and in local development you can complete the
 * verification flow by copying the URL out of the terminal.
 */
import { env, emailProvider } from "../env.ts";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const POSTMARK_ENDPOINT = "https://api.postmarkapp.com/email";
const TIMEOUT_MS = 10_000;

export interface EmailMessage {
  to: string;
  subject: string;
  htmlBody: string;
  textBody: string;
}

export interface SendResult {
  delivered: boolean;
  /** Set when the send was skipped or failed; null on success. */
  reason: string | null;
  messageId?: string;
}

export type ResendSendInput = {
  apiKey: string;
  from: string;
  message: EmailMessage;
};

export type PostmarkSendInput = {
  serverToken: string;
  from: string;
  stream: string;
  message: EmailMessage;
};

/**
 * Sends an email.
 *
 * NEVER THROWS. Callers are auth routes where a mail outage must not turn a
 * successful registration into a 500; the account is already created and the
 * user can request another link. The result object carries the outcome for
 * logging; check `delivered` if you need to branch on it.
 */
export async function sendEmail(message: EmailMessage): Promise<SendResult> {
  if (emailProvider === "resend") {
    return sendViaResend({
      apiKey: env.RESEND_API_KEY!,
      from: env.RESEND_FROM_ADDRESS!,
      message,
    });
  }
  if (emailProvider === "postmark") {
    return sendViaPostmark({
      serverToken: env.POSTMARK_SERVER_TOKEN!,
      from: env.POSTMARK_FROM_ADDRESS!,
      stream: env.POSTMARK_MESSAGE_STREAM,
      message,
    });
  }

  // Not an error: this is the documented unconfigured path.
  console.log(
    [
      "",
      "─".repeat(72),
      "EMAIL NOT SENT: no mail provider is configured.",
      `  To:      ${message.to}`,
      `  Subject: ${message.subject}`,
      "",
      message.textBody.trim(),
      "─".repeat(72),
      "",
    ].join("\n"),
  );
  return { delivered: false, reason: "mail_not_configured" };
}

export async function sendViaResend(input: ResendSendInput): Promise<SendResult> {
  const fetched = await postJson(
    RESEND_ENDPOINT,
    {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json",
    },
    {
      from: input.from,
      to: [input.message.to],
      subject: input.message.subject,
      html: input.message.htmlBody,
      text: input.message.textBody,
    },
    input.message.to,
    { timeout: "resend_timeout", unreachable: "resend_unreachable" },
  );
  if ("failed" in fetched) return fetched.failed;

  const id = typeof fetched.body.id === "string" ? fetched.body.id : undefined;
  const errorMessage =
    typeof fetched.body.message === "string" ? fetched.body.message : fetched.response.statusText;

  if (!fetched.response.ok) {
    const reason = `resend_error_${fetched.response.status}: ${errorMessage}`;
    console.error(`Email to ${input.message.to} failed: ${reason}`);
    return { delivered: false, reason };
  }

  return { delivered: true, reason: null, messageId: id };
}

export async function sendViaPostmark(input: PostmarkSendInput): Promise<SendResult> {
  const fetched = await postJson(
    POSTMARK_ENDPOINT,
    {
      "X-Postmark-Server-Token": input.serverToken,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    {
      From: input.from,
      To: input.message.to,
      Subject: input.message.subject,
      HtmlBody: input.message.htmlBody,
      TextBody: input.message.textBody,
      MessageStream: input.stream,
    },
    input.message.to,
    { timeout: "postmark_timeout", unreachable: "postmark_unreachable" },
  );
  if ("failed" in fetched) return fetched.failed;

  const errorCode = typeof fetched.body.ErrorCode === "number" ? fetched.body.ErrorCode : 0;
  const errorMessage =
    typeof fetched.body.Message === "string" ? fetched.body.Message : fetched.response.statusText;
  const messageId =
    typeof fetched.body.MessageID === "string" ? fetched.body.MessageID : undefined;

  // Postmark signals failure with a non-2xx status OR a non-zero ErrorCode in
  // an otherwise-200 response. Both must be treated as failure.
  if (!fetched.response.ok || errorCode !== 0) {
    const reason = `postmark_error_${errorCode || fetched.response.status}: ${errorMessage}`;
    console.error(`Email to ${input.message.to} failed: ${reason}`);
    return { delivered: false, reason };
  }

  return { delivered: true, reason: null, messageId };
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  to: string,
  labels: { timeout: string; unreachable: string },
): Promise<{ response: Response; body: Record<string, unknown> } | { failed: SendResult }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { response, body: json };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === "AbortError"
        ? labels.timeout
        : `${labels.unreachable}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`Email to ${to} failed: ${reason}`);
    return { failed: { delivered: false, reason } };
  } finally {
    clearTimeout(timeout);
  }
}
