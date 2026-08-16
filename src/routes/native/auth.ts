/**
 * Native auth routes: register, login, logout, session info, API tokens.
 *
 * Ghost creation lives in routes/native/invite.ts, since it is a property of
 * joining a group rather than of signing up.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import { db } from "../../db/index.ts";
import { env } from "../../env.ts";
import { hashPassword, verifyPassword, needsRehash } from "../../auth/password.ts";
import {
  createSession,
  destroySession,
  createApiToken,
  revokeApiToken,
  SESSION_COOKIE,
} from "../../auth/session.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import {
  issueVerificationToken,
  consumeVerificationToken,
} from "../../email/verification.ts";

export const authRoutes = new Hono<AppEnv>();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  firstName: z.string().min(1).max(100),
  lastName: z.string().max(100).optional(),
  defaultCurrency: z.string().length(3).toUpperCase().default("USD"),
});

function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    // Lax rather than Strict so following an invite link from a chat app still
    // arrives authenticated. None of our state-changing routes are GETs.
    sameSite: "Lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}

authRoutes.post("/register", zValidator("json", registerSchema), async (c) => {
  const input = c.req.valid("json");

  const existing = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", input.email)
    .executeTakeFirst();

  if (existing) {
    return c.json({ error: "An account with that email already exists" }, 409);
  }

  const currency = await db
    .selectFrom("currencies")
    .select("code")
    .where("code", "=", input.defaultCurrency)
    .executeTakeFirst();

  if (!currency) {
    return c.json({ error: `Unknown currency: ${input.defaultCurrency}` }, 400);
  }

  const user = await db
    .insertInto("users")
    .values({
      email: input.email,
      password_hash: await hashPassword(input.password),
      first_name: input.firstName,
      last_name: input.lastName ?? null,
      default_currency: input.defaultCurrency,
      is_ghost: 0,
    })
    .returning(["id", "email", "first_name", "last_name", "default_currency"])
    .executeTakeFirstOrThrow();

  // Fire-and-forget: a mail outage must not turn a successful registration into
  // an error. sendEmail never throws, and the user can request another link.
  const verification = await issueVerificationToken(user.id);

  const { token, expiresAt } = await createSession(user.id, c.req.header("User-Agent"));
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

  return c.json(
    {
      user: toPublicUser(user),
      emailVerified: false,
      // Lets the UI say "check your inbox" vs "email isn't configured on this
      // server" instead of claiming a message was sent when it wasn't.
      verificationEmailSent: verification.status === "sent" && verification.delivered,
    },
    201,
  );
});

authRoutes.post(
  "/login",
  zValidator("json", z.object({ email: z.string().email(), password: z.string() })),
  async (c) => {
    const { email, password } = c.req.valid("json");

    const user = await db
      .selectFrom("users")
      .select([
        "id", "email", "password_hash", "first_name", "last_name",
        "default_currency", "is_ghost", "email_verified_at",
      ])
      .where("email", "=", email)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    // Same generic message and a real hash comparison either way, so response
    // time and wording don't reveal whether the account exists.
    const stored = user?.password_hash ?? "scrypt$131072$8$1$AAAA$AAAA";
    const valid = await verifyPassword(password, stored);

    if (!user || !valid || user.is_ghost === 1) {
      return c.json({ error: "Incorrect email or password" }, 401);
    }

    // Transparently upgrade hashes when the cost parameters have moved on.
    if (needsRehash(stored)) {
      await db
        .updateTable("users")
        .set({ password_hash: await hashPassword(password) })
        .where("id", "=", user.id)
        .execute();
    }

    // Optional hard gate. Off by default so a misconfigured Postmark cannot
    // lock you out of a self-hosted server — see EMAIL_VERIFICATION_REQUIRED
    // in src/env.ts and the `npm run verify:user` escape hatch.
    if (env.EMAIL_VERIFICATION_REQUIRED && !user.email_verified_at) {
      return c.json(
        {
          error: "Confirm your email address before logging in.",
          code: "email_not_verified",
        },
        403,
      );
    }

    const { token, expiresAt } = await createSession(user.id, c.req.header("User-Agent"));
    setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

    return c.json({
      user: toPublicUser(user),
      emailVerified: user.email_verified_at !== null,
    });
  },
);

// --- Email verification -----------------------------------------------------
//
// ORDER MATTERS. Hono matches in registration order, so /verify/resend must be
// declared BEFORE /verify/:token — otherwise "resend" is captured as a token
// and the resend endpoint becomes unreachable.

/** Re-sends the verification email to the signed-in user. */
authRoutes.post("/verify/resend", requireAuth, async (c) => {
  const auth = c.get("user");

  if (auth.isGhost) {
    return c.json({ error: "Guest accounts have no email address to verify." }, 400);
  }

  const result = await issueVerificationToken(auth.id);

  switch (result.status) {
    case "sent":
      return c.json({ ok: true, delivered: result.delivered });
    case "already_verified":
      return c.json({ ok: true, alreadyVerified: true });
    case "cooldown":
      return c.json(
        {
          error: `Please wait ${result.retryAfterSeconds}s before requesting another email.`,
          retryAfterSeconds: result.retryAfterSeconds,
        },
        429,
        { "Retry-After": String(result.retryAfterSeconds) },
      );
    default:
      return c.json({ error: "This account has no email address." }, 400);
  }
});

/**
 * Confirms an address from an emailed link.
 *
 * Unauthenticated on purpose: the link often gets opened in a different browser
 * from the one that registered, and holding the token is the proof.
 */
authRoutes.post(
  "/verify/:token",
  zValidator("param", z.object({ token: z.string().min(16) })),
  async (c) => {
    const { token } = c.req.valid("param");
    const result = await consumeVerificationToken(token);

    switch (result.status) {
      case "verified":
        return c.json({ ok: true, status: "verified" });
      case "expired":
        return c.json(
          { ok: false, status: "expired", error: "That link has expired. Request a new one." },
          410,
        );
      case "already_used":
        return c.json(
          { ok: false, status: "already_used", error: "That link has already been used." },
          410,
        );
      case "email_changed":
        return c.json(
          {
            ok: false,
            status: "email_changed",
            error: "Your email address changed after this link was sent. Request a new one.",
          },
          409,
        );
      default:
        return c.json(
          { ok: false, status: "invalid", error: "That link is not valid." },
          404,
        );
    }
  },
);

authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

authRoutes.get("/me", requireAuth, async (c) => {
  const auth = c.get("user");
  return c.json({
    user: {
      id: auth.id,
      email: auth.email,
      firstName: auth.firstName,
      lastName: auth.lastName,
      isGhost: auth.isGhost,
      defaultCurrency: auth.defaultCurrency,
      emailVerified: auth.emailVerifiedAt !== null,
      // Ghosts have no address, so they must never be nagged to confirm one.
      needsEmailVerification: !auth.isGhost && auth.emailVerifiedAt === null,
    },
  });
});

// --- API tokens -------------------------------------------------------------

authRoutes.get("/tokens", requireAuth, async (c) => {
  const auth = c.get("user");
  const tokens = await db
    .selectFrom("api_tokens")
    .select(["id", "name", "created_at", "last_used_at", "revoked_at"])
    .where("user_id", "=", auth.id)
    .orderBy("created_at", "desc")
    .execute();
  return c.json({ tokens });
});

authRoutes.post(
  "/tokens",
  requireAuth,
  zValidator("json", z.object({ name: z.string().min(1).max(100) })),
  async (c) => {
    const auth = c.get("user");
    const { name } = c.req.valid("json");
    const { token, id } = await createApiToken(auth.id, name);

    // The only time the plaintext is ever available.
    return c.json({ id, name, token }, 201);
  },
);

authRoutes.delete("/tokens/:id", requireAuth, async (c) => {
  const auth = c.get("user");
  await revokeApiToken(c.req.param("id"), auth.id);
  return c.json({ ok: true });
});

function toPublicUser(user: {
  id: number;
  email: string | null;
  first_name: string;
  last_name: string | null;
  default_currency: string;
}) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    defaultCurrency: user.default_currency,
  };
}
