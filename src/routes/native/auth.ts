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
import { db, transaction } from "../../db/index.ts";
import { env, isAdminUser } from "../../env.ts";
import { hashPassword, verifyPassword, needsRehash } from "../../auth/password.ts";
import {
  createSession,
  destroySession,
  createApiToken,
  revokeApiToken,
  SESSION_COOKIE,
  type AuthenticatedUser,
} from "../../auth/session.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import {
  issueVerificationToken,
  consumeVerificationToken,
} from "../../email/verification.ts";
import {
  issuePasswordReset,
  lookupPasswordReset,
  completePasswordReset,
} from "../../email/reset.ts";
import {
  startEmailSignup,
  lookupSignupToken,
  takeSignupForRegister,
  attachSignupUser,
  requestIp,
} from "../../email/signup.ts";
import { logChange } from "../../domain/sync-log.ts";
import { ulid } from "../../domain/ulid.ts";
import { MAX_NAME_LENGTH, personCamel } from "../../domain/person.ts";
import { parseAvatarPattern } from "../../domain/avatar-pattern.ts";
import {
  hasIdentityPatch,
  identityColumns,
  identityPatchSchema,
} from "./person-schema.ts";
import { adoptConfirmedImportedGhostByEmail } from "../../domain/splitwise-identity.ts";
import { deleteAccount, DELETE_ACCOUNT_CONFIRMATION } from "../../domain/delete-account.ts";

const signupSchema = z.object({
  email: z.string().email(),
  next: z.string().max(2000).optional(),
});

const registerSchema = z.object({
  token: z.string().min(16),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  nickname: identityPatchSchema.shape.nickname,
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

const patchMeSchema = identityPatchSchema.extend({
  defaultCurrency: z.string().length(3).toUpperCase().optional(),
});

function meUser(user: AuthenticatedUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    nickname: user.nickname,
    iconLetters: user.iconLetters,
    iconEmoji: user.iconEmoji,
    iconHue: user.iconHue,
    iconPattern: user.iconPattern,
    isGhost: user.isGhost,
    defaultCurrency: user.defaultCurrency,
    emailVerified: user.emailVerifiedAt !== null,
    // Ghosts have no address, so they must never be nagged to confirm one.
    needsEmailVerification: !user.isGhost && user.emailVerifiedAt === null,
    isAdmin: isAdminUser(user),
  };
}

function toPublicUser(user: {
  id: string;
  email: string | null;
  name: string;
  nickname: string | null;
  icon_letters: string | null;
  icon_emoji: string | null;
  icon_hue: number | null;
  icon_pattern: string | null;
  default_currency: string;
  is_ghost?: number;
  email_verified_at?: string | null;
}) {
  const isGhost = user.is_ghost === 1;
  const emailVerified = user.email_verified_at != null;
  return {
    id: user.id,
    email: user.email,
    ...personCamel(user),
    defaultCurrency: user.default_currency,
    isGhost,
    emailVerified,
    needsEmailVerification: !isGhost && !emailVerified,
    isAdmin: isAdminUser({ email: user.email, isGhost }),
  };
}

class SignupTokenError extends Error {
  readonly code: "invalid" | "exists";
  constructor(code: "invalid" | "exists") {
    super(code);
    this.name = "SignupTokenError";
    this.code = code;
  }
}

function passwordResetTokenFailure(status: "invalid" | "expired" | "already_used" | "email_changed"): {
  body: { ok: false; status: typeof status; error: string };
  statusCode: 404 | 409 | 410;
} {
  switch (status) {
    case "expired":
      return {
        body: { ok: false, status, error: "That link has expired. Request a new one." },
        statusCode: 410,
      };
    case "already_used":
      return {
        body: { ok: false, status, error: "That link has already been used." },
        statusCode: 410,
      };
    case "email_changed":
      return {
        body: {
          ok: false,
          status,
          error: "Your email address changed after this link was sent. Request a new one.",
        },
        statusCode: 409,
      };
    default:
      return {
        body: { ok: false, status, error: "That link is not valid." },
        statusCode: 404,
      };
  }
}

export const authRoutes = new Hono<AppEnv>()
  .post("/signup", zValidator("json", signupSchema), async (c) => {
  const { email, next } = c.req.valid("json");
  const result = await startEmailSignup({
    email,
    ip: requestIp(c),
    emailVerificationRequired: env.EMAIL_VERIFICATION_REQUIRED,
    nextPath: next,
  });

  switch (result.status) {
    case "exists":
      return c.json({ error: "An account with that email already exists" }, 409);
    case "cooldown":
    case "ip_limited":
      return c.json(
        {
          error: `Please wait ${result.retryAfterSeconds}s before trying again.`,
          retryAfterSeconds: result.retryAfterSeconds,
        },
        429,
        { "Retry-After": String(result.retryAfterSeconds) },
      );
    default:
      return c.json({
        ok: true,
        email,
        delivered: result.delivered,
        // Present only when verification is not required. The frontend follows
        // this URL to the complete-account form so a box with no mail provider
        // can still finish signup. When required is on, the URL is emailed and
        // this is null.
        verifyUrl: result.verifyUrl,
      });
  }
})
  .post("/register", zValidator("json", registerSchema), async (c) => {
  const input = c.req.valid("json");

  const currency = await db
    .selectFrom("currencies")
    .select("code")
    .where("code", "=", input.defaultCurrency)
    .executeTakeFirst();

  if (!currency) {
    return c.json({ error: `Unknown currency: ${input.defaultCurrency}` }, 400);
  }

  const passwordHash = await hashPassword(input.password);

  let user;
  try {
    user = await transaction(async (trx) => {
      const signup = await takeSignupForRegister(trx, input.token);
      if (!signup) {
        throw new SignupTokenError("invalid");
      }

      const existing = await trx
        .selectFrom("users")
        .select("id")
        .where("email", "=", signup.email)
        .where("is_ghost", "=", 0)
        .executeTakeFirst();

      if (existing) {
        throw new SignupTokenError("exists");
      }

      const created = await trx
        .insertInto("users")
        .values({
          id: ulid(),
          email: signup.email,
          password_hash: passwordHash,
          name: input.name,
          nickname: input.nickname ?? null,
          default_currency: input.defaultCurrency,
          is_ghost: 0,
          email_verified_at: new Date().toISOString(),
        })
        .returning([
          "id",
          "email",
          "name",
          "nickname",
          "icon_letters",
          "icon_emoji",
          "icon_hue",
          "icon_pattern",
          "default_currency",
          "email_verified_at",
        ])
        .executeTakeFirstOrThrow();

      const attached = await attachSignupUser(trx, signup.id, created.id);
      if (!attached) {
        throw new SignupTokenError("invalid");
      }

      return created;
    });
  } catch (err) {
    if (err instanceof SignupTokenError) {
      if (err.code === "exists") {
        return c.json({ error: "An account with that email already exists" }, 409);
      }
      return c.json({ error: "That link is not valid. Request a new one." }, 404);
    }
    throw err;
  }

  // A confirmed Splitwise person imported as a placeholder at this address
  // is this account. Dummy / invite-only ghosts still need a guest link.
  const adopted = await adoptConfirmedImportedGhostByEmail(user.id, user.email!);

  const { token, expiresAt } = await createSession(user.id, c.req.header("User-Agent"));
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

  return c.json(
    {
      user: toPublicUser(user),
      emailVerified: true,
      claimedImportedHistory: adopted !== null,
    },
    201,
  );
})
  .post(
  "/login",
  zValidator("json", z.object({ email: z.string().email(), password: z.string() })),
  async (c) => {
    const { email, password } = c.req.valid("json");

    const user = await db
      .selectFrom("users")
      .select([
        "id",
        "email",
        "password_hash",
        "name",
        "nickname",
        "icon_letters",
        "icon_emoji",
        "icon_hue",
        "icon_pattern",
        "default_currency",
        "is_ghost",
        "email_verified_at",
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

    // Optional hard gate. Off by default so a misconfigured mail provider
    // cannot lock you out of a self-hosted server. See EMAIL_VERIFICATION_REQUIRED
    // in src/env.ts and the `yarn verify:user` escape hatch.
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
)
// --- Password reset ---------------------------------------------------------
//
// ORDER MATTERS the same way as /verify: /password/forgot is a static path
// and would still win against /password/reset/:token, but keep the request
// endpoint first so a future /password/:token cannot swallow it.
//
// The forgot response is identical whether the address has an account or
// not. Completing a reset ends other web sessions and opens a new one.

  .post(
  "/password/forgot",
  zValidator("json", z.object({ email: z.string().email() })),
  async (c) => {
    await issuePasswordReset(c.req.valid("json").email);
    return c.json({ ok: true });
  },
)
  .get(
  "/password/reset/:token",
  zValidator("param", z.object({ token: z.string().min(16) })),
  async (c) => {
    const { token } = c.req.valid("param");
    const result = await lookupPasswordReset(token);
    if (result.status === "pending") {
      return c.json({ ok: true, email: result.email });
    }
    const failure = passwordResetTokenFailure(result.status);
    return c.json(failure.body, failure.statusCode);
  },
)
  .post(
  "/password/reset/:token",
  zValidator("param", z.object({ token: z.string().min(16) })),
  zValidator(
    "json",
    z.object({
      password: z.string().min(8, "Password must be at least 8 characters"),
    }),
  ),
  async (c) => {
    const { token } = c.req.valid("param");
    const { password } = c.req.valid("json");

    const pending = await lookupPasswordReset(token);
    if (pending.status !== "pending") {
      const failure = passwordResetTokenFailure(pending.status);
      return c.json(failure.body, failure.statusCode);
    }

    const result = await completePasswordReset(token, await hashPassword(password));
    if (result.status !== "reset") {
      const failure = passwordResetTokenFailure(result.status);
      return c.json(failure.body, failure.statusCode);
    }

    const user = await db
      .selectFrom("users")
      .select([
        "id",
        "email",
        "name",
        "nickname",
        "icon_letters",
        "icon_emoji",
        "icon_hue",
        "icon_pattern",
        "default_currency",
        "is_ghost",
        "email_verified_at",
      ])
      .where("id", "=", result.userId)
      .executeTakeFirstOrThrow();

    const session = await createSession(user.id, c.req.header("User-Agent"));
    setCookie(c, SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

    return c.json({
      user: toPublicUser(user),
      emailVerified: true,
    });
  },
)
// --- Email verification -----------------------------------------------------
//
// ORDER MATTERS. Hono matches in registration order, so /verify/resend must be
// declared BEFORE /verify/:token; otherwise "resend" is captured as a token
// and the resend endpoint becomes unreachable.

/** Re-sends the verification email to the signed-in user. */
  .post("/verify/resend", requireAuth, async (c) => {
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
})
/**
 * Confirms an address from an emailed (or, when verification is not required,
 * client-returned) link.
 *
 * Two kinds of token share this URL:
 *   - a pending signup (`emails` table): returns the address so the complete-
 *     account form can render. Holding the token is the proof; register
 *     consumes it.
 *   - an existing-account verification (`email_tokens`): marks the address
 *     verified. Unauthenticated on purpose: the link often gets opened in a
 *     different browser from the one that registered.
 */
  .post(
  "/verify/:token",
  zValidator("param", z.object({ token: z.string().min(16) })),
  async (c) => {
    const { token } = c.req.valid("param");
    const signup = await lookupSignupToken(token);

    if (signup.status !== "invalid") {
      switch (signup.status) {
        case "pending":
          return c.json({
            ok: true,
            status: "pending_signup",
            email: signup.email,
            next: signup.nextPath,
          });
        case "expired":
          return c.json(
            { ok: false, status: "expired", error: "That link has expired. Request a new one." },
            410,
          );
        default:
          return c.json(
            { ok: false, status: "already_used", error: "That link has already been used." },
            410,
          );
      }
    }

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
)
  .post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
})
  .get("/me", requireAuth, async (c) => {
  return c.json({ user: meUser(c.get("user")) });
})
  .patch("/me", requireAuth, zValidator("json", patchMeSchema), async (c) => {
  const auth = c.get("user");
  const input = c.req.valid("json");

  if (input.defaultCurrency === undefined && !hasIdentityPatch(input)) {
    return c.json({ error: "Nothing to update." }, 400);
  }

  let defaultCurrency = auth.defaultCurrency;
  if (input.defaultCurrency !== undefined) {
    const currency = await db
      .selectFrom("currencies")
      .select("code")
      .where("code", "=", input.defaultCurrency)
      .executeTakeFirst();

    if (!currency) {
      return c.json({ error: `Unknown currency: ${input.defaultCurrency}` }, 400);
    }
    defaultCurrency = input.defaultCurrency;
  }

  const identity = identityColumns(input);

  await transaction(async (trx) => {
    await trx
      .updateTable("users")
      .set({
        ...identity,
        ...(input.defaultCurrency !== undefined
          ? { default_currency: input.defaultCurrency }
          : {}),
        updated_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      })
      .where("id", "=", auth.id)
      .execute();

    // The one place a standalone `user` log row is written. Everybody ELSE's name
    // travels nested on the expense, membership and friendship payloads they
    // appear in (docs/OFFLINE.md); this is your own profile, which your other
    // devices cache and render before the network answers.
    await logChange(trx, { entity: "user", entityId: auth.id, actorUserId: auth.id });
  });

  return c.json({
    user: meUser({
      ...auth,
      defaultCurrency,
      name: identity.name ?? auth.name,
      nickname: identity.nickname !== undefined ? identity.nickname : auth.nickname,
      iconLetters:
        identity.icon_letters !== undefined ? identity.icon_letters : auth.iconLetters,
      iconEmoji: identity.icon_emoji !== undefined ? identity.icon_emoji : auth.iconEmoji,
      iconHue: identity.icon_hue !== undefined ? identity.icon_hue : auth.iconHue,
      iconPattern:
        identity.icon_pattern !== undefined
          ? parseAvatarPattern(identity.icon_pattern)
          : auth.iconPattern,
    }),
  });
})
  /**
   * Close the account. Confirmation is in the body so a stray POST cannot do
   * this. If another real account still shares groups or expenses, the row
   * becomes a ghost rather than taking their balances with it. Otherwise the
   * ledger is wiped and the login is retired.
   */
  .post(
  "/delete",
  requireAuth,
  zValidator("json", z.object({ confirm: z.literal(DELETE_ACCOUNT_CONFIRMATION) })),
  async (c) => {
    const result = await deleteAccount(c.get("user").id);
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json(result);
  },
)
// --- API tokens -------------------------------------------------------------
  .get("/tokens", requireAuth, async (c) => {
  const auth = c.get("user");
  const tokens = await db
    .selectFrom("api_tokens")
    .select(["id", "name", "created_at", "last_used_at", "revoked_at"])
    .where("user_id", "=", auth.id)
    .orderBy("created_at", "desc")
    .execute();
  return c.json({ tokens });
})
  .post(
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
)
  .delete("/tokens/:id", requireAuth, async (c) => {
  const auth = c.get("user");
  await revokeApiToken(c.req.param("id"), auth.id);
  return c.json({ ok: true });
});
