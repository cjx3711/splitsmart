/**
 * Email bodies.
 *
 * Plain functions returning strings; no template engine, no HTML framework.
 * Every message ships both an HTML and a text part because Postmark scores
 * text-less mail worse for deliverability, and text is what shows up in the
 * console when Postmark is unconfigured.
 *
 * Inline styles only: email clients strip <style> blocks, and Gmail in
 * particular drops anything in <head>.
 */

interface VerificationEmail {
  firstName: string;
  verifyUrl: string;
  expiresInHours: number;
}

export function verificationEmail(input: VerificationEmail): {
  subject: string;
  htmlBody: string;
  textBody: string;
} {
  const { firstName, verifyUrl, expiresInHours } = input;

  return {
    subject: "Confirm your SplitSmart email address",

    textBody: `Hi ${firstName},

Confirm your email address to finish setting up your SplitSmart account:

${verifyUrl}

This link expires in ${expiresInHours} hours and can only be used once.

If you didn't create a SplitSmart account, you can ignore this email.
`,

    htmlBody: `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#16191d;line-height:1.5;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dfe3e8;border-radius:8px;padding:32px;">
      <h1 style="margin:0 0 16px;font-size:20px;">Confirm your email</h1>
      <p style="margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>
      <p style="margin:0 0 24px;">
        Confirm your email address to finish setting up your SplitSmart account.
      </p>
      <p style="margin:0 0 24px;">
        <a href="${escapeAttribute(verifyUrl)}"
           style="display:inline-block;background:#10806a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">
          Confirm email address
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:14px;color:#6b7280;">
        This link expires in ${expiresInHours} hours and can only be used once.
      </p>
      <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">
        If the button doesn't work, paste this into your browser:<br />
        <span style="word-break:break-all;">${escapeHtml(verifyUrl)}</span>
      </p>
      <p style="margin:0;font-size:14px;color:#6b7280;border-top:1px solid #dfe3e8;padding-top:16px;">
        If you didn't create a SplitSmart account, you can ignore this email.
      </p>
    </div>
  </body>
</html>`,
  };
}

interface FriendInviteEmail {
  /** The person being invited. Ghosts always have one, even without an email. */
  firstName: string;
  /** Who added them. */
  inviterName: string;
  /**
   * Where the invite lands. For a brand-new ghost this carries their recovery
   * code and signs them straight in; for someone who already has an account it
   * is just the app's front door.
   */
  acceptUrl: string;
  /** False when the recipient already had a SplitSmart account. */
  isNewAccount: boolean;
}

export function friendInviteEmail(input: FriendInviteEmail): {
  subject: string;
  htmlBody: string;
  textBody: string;
} {
  const { firstName, inviterName, acceptUrl, isNewAccount } = input;

  const lead = isNewAccount
    ? `${inviterName} added you on SplitSmart, a shared ledger for splitting expenses. Open the link below to pick up your account; no password needed to start.`
    : `${inviterName} added you as a friend on SplitSmart. You can see what you owe each other next time you log in.`;

  const action = isNewAccount ? "Accept the invite" : "Open SplitSmart";

  return {
    subject: `${inviterName} added you on SplitSmart`,

    textBody: `Hi ${firstName},

${lead}

${acceptUrl}
${
  isNewAccount
    ? `
Keep this link. It is the only way back into your account until you set a password.
`
    : ""
}
If you weren't expecting this, you can ignore this email.
`,

    htmlBody: `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#16191d;line-height:1.5;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #dfe3e8;border-radius:8px;padding:32px;">
      <h1 style="margin:0 0 16px;font-size:20px;">You're on SplitSmart</h1>
      <p style="margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>
      <p style="margin:0 0 24px;">${escapeHtml(lead)}</p>
      <p style="margin:0 0 24px;">
        <a href="${escapeAttribute(acceptUrl)}"
           style="display:inline-block;background:#10806a;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;">
          ${escapeHtml(action)}
        </a>
      </p>
      ${
        isNewAccount
          ? `<p style="margin:0 0 8px;font-size:14px;color:#6b7280;">
        Keep this link. It is the only way back into your account until you set a password.
      </p>`
          : ""
      }
      <p style="margin:0 0 24px;font-size:14px;color:#6b7280;">
        If the button doesn't work, paste this into your browser:<br />
        <span style="word-break:break-all;">${escapeHtml(acceptUrl)}</span>
      </p>
      <p style="margin:0;font-size:14px;color:#6b7280;border-top:1px solid #dfe3e8;padding-top:16px;">
        If you weren't expecting this, you can ignore this email.
      </p>
    </div>
  </body>
</html>`,
  };
}

/**
 * Escapes text interpolated into HTML.
 *
 * First names come from user input and land in the HTML body, so this is a real
 * injection boundary, not a formality.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Escapes a URL for an href attribute. Tokens are base64url, but be strict. */
function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
