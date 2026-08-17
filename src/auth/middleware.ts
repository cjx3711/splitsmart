/**
 * Hono auth middleware.
 *
 * `requireAuth` accepts EITHER a session cookie or a bearer API token, so the
 * same route tree serves the web UI and external API clients. Handlers read the
 * caller with `c.get("user")`, which is typed via AppEnv below.
 *
 * WHAT IT DOES NOT ACCEPT: a guest access link (`Bearer link_...`). Those are
 * scoped to one group or one friendship and are handled only by
 * /api/v1/guest/*, which re-checks that scope on every handler. Falling through
 * to a cookie here would be worse than useless: a guest browser has no cookie,
 * so the practical effect of a missing check is that a link token silently
 * behaves like an anonymous request instead of a clear 401. See docs/GUEST.md.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import {
  SESSION_COOKIE,
  resolveSession,
  resolveApiToken,
  type AuthenticatedUser,
} from "./session.ts";
import { isLinkToken } from "../domain/access-links.ts";

export interface AppEnv {
  Variables: {
    user: AuthenticatedUser;
  };
}

/** Distinguishes "you sent a guest link here" from "you sent nothing". */
type Identity =
  | { kind: "user"; user: AuthenticatedUser }
  | { kind: "guest_link" }
  | { kind: "none" };

async function identify(c: Context): Promise<Identity> {
  const header = c.req.header("Authorization");
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7).trim();

    // A guest secret is never a user credential, on this tree or the compat
    // one. Reject rather than ignore, so the client is told to use /guest.
    if (isLinkToken(token)) return { kind: "guest_link" };

    if (token) {
      const user = await resolveApiToken(token);
      if (user) return { kind: "user", user };
    }
  }

  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) {
    const user = await resolveSession(cookie);
    if (user) return { kind: "user", user };
  }

  return { kind: "none" };
}

/** Rejects unauthenticated requests with 401. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const identity = await identify(c);

  if (identity.kind === "guest_link") {
    return c.json(
      { error: "A guest link cannot be used here. Use /api/v1/guest.", guestLink: true },
      401,
    );
  }
  if (identity.kind === "none") {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("user", identity.user);
  await next();
};

/** Populates `user` when present but allows anonymous access. */
export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const identity = await identify(c);
  if (identity.kind === "user") c.set("user", identity.user);
  await next();
};
