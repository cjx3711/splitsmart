import { z } from "zod";

/** Missing or whitespace-only env values are unset, not empty strings. */
const blankToUndef = (value: unknown) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const optionalSecret = z.preprocess(blankToUndef, z.string().optional());

/**
 * Bare email, or `Name <email>`. Resend documents the named form; Postmark
 * accepts it too.
 */
function isMailFrom(value: string): boolean {
  const named = value.match(/^(.+?)\s*<([^<>]+)>$/);
  const email = (named?.[2] ?? value).trim();
  return z.string().email().safeParse(email).success;
}

const optionalFromAddress = z.preprocess(
  blankToUndef,
  z
    .string()
    .refine(isMailFrom, "must be an email address, optionally 'Name <email>'")
    .optional(),
);

/**
 * Environment is validated once at import time and then frozen. If a required
 * var is missing the process exits immediately with a readable message rather
 * than failing later at the first request.
 */
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(5545),
  DATABASE_PATH: z.string().default("./data/splitsmart.db"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be >= 32 chars"),
  APP_ORIGIN: z.string().url().default("http://localhost:5444"),

  /**
   * Base URL of the Splitwise API the importer reads from.
   *
   * There is deliberately NO SPLITWISE_API_KEY here. An import is per-user, so
   * the key belongs to the person doing it, not to the server: it arrives on
   * the request (see src/routes/native/import.ts) and is never stored. The only
   * reason this URL is configurable is so a test, or an agent driving the
   * wizard, can point the importer at a fake Splitwise on localhost.
   */
  SPLITWISE_API_BASE: z.string().url().default("https://secure.splitwise.com/api/v3.0"),

  // Mail. Configure Resend OR Postmark, never both complete pairs. Absence of
  // both is a no-op, never a boot failure; sending degrades to a console log
  // (see src/email/send.ts), which is also how you complete the verification
  // flow locally without a mail provider.
  RESEND_API_KEY: optionalSecret,
  RESEND_FROM_ADDRESS: optionalFromAddress,
  POSTMARK_SERVER_TOKEN: optionalSecret,
  POSTMARK_FROM_ADDRESS: optionalFromAddress,
  // Transactional mail must not go out on a broadcast stream.
  POSTMARK_MESSAGE_STREAM: z.string().default("outbound"),

  /**
   * When false (the default), signup returns the verification URL to the
   * client so the complete-account form can open without a mail provider.
   * Unverified existing accounts can still log in; the UI shows a banner.
   *
   * When true, that URL is emailed and omitted from the API response, and
   * login is blocked until the address is confirmed. Defaulting to false is
   * deliberate for self-hosted use; combined with a misconfigured mail
   * provider it would otherwise lock you out of your own server. The escape
   * hatch is `yarn verify:user <email>`.
   */
  EMAIL_VERIFICATION_REQUIRED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * Smoke stack only (`yarn smoke:server`). The demo seed runs the recurring
   * job itself with a pinned clock; letting the server tick on boot would make
   * capture depend on how many times the process restarted.
   */
  DISABLE_RECURRING_SCHEDULER: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * Comma-separated emails that may open the usage admin panel. Empty (the
   * default) means nobody. Compared case-insensitively against users.email;
   * ghosts have no email and can never match. Not a DB role — self-hosted
   * operators control it from the environment.
   */
  ADMIN_EMAILS: z
    .string()
    .optional()
    .default("")
    .transform((v) => parseAdminEmails(v)),
});

/** Split, trim, lower-case; drop empties. Exported for unit tests. */
export function parseAdminEmails(raw: string): ReadonlySet<string> {
  const emails = raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return new Set(emails);
}

export type EmailProvider = "resend" | "postmark";

export type EmailCredentials = {
  RESEND_API_KEY?: string;
  RESEND_FROM_ADDRESS?: string;
  POSTMARK_SERVER_TOKEN?: string;
  POSTMARK_FROM_ADDRESS?: string;
};

/**
 * Picks at most one mail provider. A complete pair is token/key + from-address.
 * Both pairs is a misconfiguration: we refuse to guess which one to send with.
 */
export function resolveEmailProvider(input: EmailCredentials): EmailProvider | null {
  const resend = Boolean(input.RESEND_API_KEY && input.RESEND_FROM_ADDRESS);
  const postmark = Boolean(input.POSTMARK_SERVER_TOKEN && input.POSTMARK_FROM_ADDRESS);
  if (resend && postmark) {
    throw new Error(
      "Set either Resend (RESEND_API_KEY + RESEND_FROM_ADDRESS) or Postmark (POSTMARK_SERVER_TOKEN + POSTMARK_FROM_ADDRESS), not both. See .env.example.",
    );
  }
  if (resend) return "resend";
  if (postmark) return "postmark";
  return null;
}

function load() {
  // In test runs we don't want to require a real .env file.
  if (process.env.NODE_ENV === "test" && !process.env.SESSION_SECRET) {
    process.env.SESSION_SECRET = "test-secret-that-is-long-enough-to-pass-ok";
  }

  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Invalid environment:\n${issues}\n\nSee .env.example.`);
    process.exit(1);
  }
  try {
    resolveEmailProvider(parsed.data);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const env = load();

export const emailProvider = resolveEmailProvider(env);
export const emailEnabled = emailProvider !== null;

/** True when this authenticated user is listed in ADMIN_EMAILS. */
export function isAdminUser(user: {
  email: string | null;
  isGhost: boolean;
}): boolean {
  if (user.isGhost || !user.email) return false;
  return env.ADMIN_EMAILS.has(user.email.trim().toLowerCase());
}
