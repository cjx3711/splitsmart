/**
 * Hono auth middleware.
 *
 * `requireAuth` accepts EITHER a session cookie or a bearer API token, so the
 * same route tree serves the web UI and external API clients. Handlers read the
 * caller with `c.get("user")`, which is typed via AppEnv below.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import {
  SESSION_COOKIE,
  resolveSession,
  resolveApiToken,
  type AuthenticatedUser,
} from "./session.ts";

export interface AppEnv {
  Variables: {
    user: AuthenticatedUser;
  };
}

async function identify(c: Context): Promise<AuthenticatedUser | null> {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    if (token) {
      const user = await resolveApiToken(token);
      if (user) return user;
    }
  }

  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) return resolveSession(cookie);

  return null;
}

/** Rejects unauthenticated requests with 401. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await identify(c);
  if (!user) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  c.set("user", user);
  await next();
};

/** Populates `user` when present but allows anonymous access. */
export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = await identify(c);
  if (user) c.set("user", user);
  await next();
};
