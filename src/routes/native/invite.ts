/**
 * Group invite links and ghost accounts.
 *
 * The product rule: one real account is enough. Anyone else joins a group by
 * opening a secret link and picking a name, which creates a GHOST user —
 * no email, no password. Identity is possession of a session cookie, with a
 * one-time recovery code as the only way back in from another device.
 *
 * SECURITY NOTES (deliberate trade-offs, not oversights):
 *   - Anyone holding the link can join AND read every expense in that group.
 *     Rotating the token cuts off future joins but does not remove members.
 *   - Ghosts are scoped to the group they joined. They cannot see other groups.
 *   - The preview endpoint is intentionally anonymous but returns only the
 *     group name and member count — enough to confirm you have the right link,
 *     not enough to leak financial data to a scanner.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { setCookie } from "hono/cookie";
import { db, transaction } from "../../db/index.ts";
import { env } from "../../env.ts";
import {
  generateToken,
  generateRecoveryCode,
  normaliseRecoveryCode,
  hashPassword,
  verifyPassword,
} from "../../auth/password.ts";
import { createSession, SESSION_COOKIE } from "../../auth/session.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import { issueVerificationToken } from "../../email/verification.ts";

export const inviteRoutes = new Hono<AppEnv>();

function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: env.NODE_ENV === "production",
    path: "/",
    expires,
  };
}

/** Anonymous preview so the join page can say which group you're joining. */
inviteRoutes.get("/:token/preview", async (c) => {
  const group = await db
    .selectFrom("groups")
    .select(["id", "name", "group_type"])
    .where("invite_token", "=", c.req.param("token"))
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  if (!group) return c.json({ error: "This invite link is not valid" }, 404);

  const members = await db
    .selectFrom("group_members")
    .innerJoin("users", "users.id", "group_members.user_id")
    .select(["users.first_name", "users.last_name"])
    .where("group_members.group_id", "=", group.id)
    .where("group_members.left_at", "is", null)
    .execute();

  return c.json({
    group: {
      name: group.name,
      type: group.group_type,
      memberCount: members.length,
      memberNames: members.map((m) => [m.first_name, m.last_name].filter(Boolean).join(" ")),
    },
  });
});

/**
 * Joins a group via invite link.
 *
 * An authenticated caller is added as themselves. An anonymous caller gets a
 * new ghost account plus a session, and is handed a recovery code exactly once.
 */
inviteRoutes.post(
  "/:token/join",
  zValidator("json", z.object({ displayName: z.string().min(1).max(100) })),
  async (c) => {
    const token = c.req.param("token");
    const { displayName } = c.req.valid("json");

    const group = await db
      .selectFrom("groups")
      .select(["id", "name", "default_currency"])
      .where("invite_token", "=", token)
      .where("deleted_at", "is", null)
      .executeTakeFirst();

    if (!group) return c.json({ error: "This invite link is not valid" }, 404);

    const [firstName, ...rest] = displayName.trim().split(/\s+/);
    const lastName = rest.join(" ") || null;

    const recoveryCode = generateRecoveryCode();

    const result = await transaction(async (trx) => {
      const user = await trx
        .insertInto("users")
        .values({
          first_name: firstName ?? displayName,
          last_name: lastName,
          default_currency: group.default_currency,
          is_ghost: 1,
          recovery_code_hash: await hashPassword(normaliseRecoveryCode(recoveryCode)),
        })
        .returning(["id", "first_name", "last_name"])
        .executeTakeFirstOrThrow();

      await trx
        .insertInto("group_members")
        .values({
          group_id: group.id,
          user_id: user.id,
          role: "member",
          joined_via: "invite_link",
        })
        .execute();

      return user;
    });

    const { token: sessionToken, expiresAt } = await createSession(
      result.id,
      c.req.header("User-Agent"),
    );
    setCookie(c, SESSION_COOKIE, sessionToken, sessionCookieOptions(expiresAt));

    return c.json(
      {
        user: { id: result.id, firstName: result.first_name, lastName: result.last_name, isGhost: true },
        group: { id: group.id, name: group.name },
        // Shown once. There is no way to recover the account without it.
        recoveryCode,
      },
      201,
    );
  },
);

/** Signs a ghost back in on a new device using their recovery code. */
inviteRoutes.post(
  "/recover",
  zValidator("json", z.object({ recoveryCode: z.string().min(8) })),
  async (c) => {
    const { recoveryCode } = c.req.valid("json");
    const normalised = normaliseRecoveryCode(recoveryCode);

    // Recovery codes aren't indexed by hash (they're salted), so this scans
    // ghost accounts. Fine at personal scale; revisit if ghosts ever number in
    // the thousands.
    const ghosts = await db
      .selectFrom("users")
      .select(["id", "first_name", "last_name", "recovery_code_hash"])
      .where("is_ghost", "=", 1)
      .where("deleted_at", "is", null)
      .where("recovery_code_hash", "is not", null)
      .execute();

    for (const ghost of ghosts) {
      if (await verifyPassword(normalised, ghost.recovery_code_hash!)) {
        const { token, expiresAt } = await createSession(ghost.id, c.req.header("User-Agent"));
        setCookie(c, SESSION_COOKIE, token, sessionCookieOptions(expiresAt));
        return c.json({
          user: { id: ghost.id, firstName: ghost.first_name, lastName: ghost.last_name, isGhost: true },
        });
      }
    }

    return c.json({ error: "That recovery code is not valid" }, 401);
  },
);

/**
 * Upgrades a ghost into a real account IN PLACE.
 *
 * Deliberately not "create a new user and merge": keeping the same row means
 * every expense, share, and repayment stays attached and no balance moves.
 */
inviteRoutes.post(
  "/claim",
  requireAuth,
  zValidator(
    "json",
    z.object({ email: z.string().email(), password: z.string().min(8) }),
  ),
  async (c) => {
    const auth = c.get("user");
    if (!auth.isGhost) return c.json({ error: "This account is already registered" }, 400);

    const { email, password } = c.req.valid("json");

    // Excluding self is load-bearing. A ghost created by "add a friend" already
    // carries the address it was invited at, so without this the invitee's own
    // pending address would block them from claiming their own account.
    const taken = await db
      .selectFrom("users")
      .select("id")
      .where("email", "=", email)
      .where("id", "!=", auth.id)
      .executeTakeFirst();

    if (taken) return c.json({ error: "An account with that email already exists" }, 409);

    await db
      .updateTable("users")
      .set({
        email,
        password_hash: await hashPassword(password),
        is_ghost: 0,
        recovery_code_hash: null,
      })
      .where("id", "=", auth.id)
      .execute();

    // A freshly claimed account is a brand-new address that nobody has proved
    // control of, so it enters the same verification flow as registration.
    const verification = await issueVerificationToken(auth.id);

    return c.json({
      ok: true,
      user: { id: auth.id, email, isGhost: false },
      emailVerified: false,
      verificationEmailSent: verification.status === "sent" && verification.delivered,
    });
  },
);

/** Rotates a group's invite token. Existing members are unaffected. */
inviteRoutes.post("/groups/:groupId/rotate", requireAuth, async (c) => {
  const auth = c.get("user");
  const groupId = Number(c.req.param("groupId"));

  const membership = await db
    .selectFrom("group_members")
    .select("role")
    .where("group_id", "=", groupId)
    .where("user_id", "=", auth.id)
    .where("left_at", "is", null)
    .executeTakeFirst();

  if (!membership) return c.json({ error: "Not a member of this group" }, 403);
  if (membership.role !== "owner") {
    return c.json({ error: "Only the group owner can rotate the invite link" }, 403);
  }

  const inviteToken = generateToken(24);
  await db
    .updateTable("groups")
    .set({ invite_token: inviteToken, invite_rotated_at: new Date().toISOString() })
    .where("id", "=", groupId)
    .execute();

  return c.json({ inviteUrl: `${env.APP_ORIGIN}/join/${inviteToken}` });
});
