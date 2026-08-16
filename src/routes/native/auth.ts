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

  const { token, expiresAt } = await createSession(user.id, c.req.header("User-Agent"));
  setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

  return c.json({ user: toPublicUser(user) }, 201);
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
        "default_currency", "is_ghost",
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

    const { token, expiresAt } = await createSession(user.id, c.req.header("User-Agent"));
    setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(expiresAt));

    return c.json({ user: toPublicUser(user) });
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
