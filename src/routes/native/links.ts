/**
 * Owner-side management of guest links.
 *
 * Only account holders reach these; a guest can never mint, rotate or revoke
 * anything, which is the difference between sharing a group and handing over
 * the group. The guest tree (/api/v1/guest) has no route into this file.
 *
 * The plaintext secret is stored so owners can copy a live link again. Listing
 * returns the URL for links the caller may manage. Rotating replaces the secret
 * in the same transaction the old one is revoked.
 *
 * Independence between links is deliberate (docs/GUEST.md):
 *
 *   - rotating the general group link does not touch per-member or friend links
 *   - revoking one person's member link does not touch the general link, so
 *     they can still pick themselves there until you turn that off too
 *   - removing a member from a group DOES revoke their member link, because a
 *     removal that leaves a working door open is not a removal (that one lives
 *     in routes/native/groups.ts, next to the removal itself)
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db, transaction } from "../../db/index.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import {
  mintAccessLink,
  listGroupLinks,
  findFriendLink,
  revokeAccessLink,
  resolveLinkExpiry,
  AccessLinkError,
  type LinkSummary,
} from "../../domain/access-links.ts";
import { listRelatedUserIds } from "../../domain/friends.ts";
import { isUlid } from "../../domain/ulid.ts";
import { ulidSchema } from "./expense-schema.ts";

async function membershipOf(groupId: string, userId: string) {
  return db
    .selectFrom("group_members")
    .select("role")
    .where("group_id", "=", groupId)
    .where("user_id", "=", userId)
    .where("left_at", "is", null)
    .executeTakeFirst();
}

const mintSchema = z
  .object({
    kind: z.enum(["group", "group_member", "friend"]),
    groupId: ulidSchema.nullable().optional(),
    userId: ulidSchema.nullable().optional(),
    /**
     * ISO-8601, optional. Absent means 3 months from mint. Cannot exceed 3 months.
     */
    expiresAt: z.string().datetime().optional(),
  })
  .refine((body) => body.kind === "friend" || body.groupId, {
    message: "A group link needs a group",
    path: ["groupId"],
  })
  .refine((body) => body.kind === "group" || body.userId, {
    message: "This link needs the person it acts as",
    path: ["userId"],
  });

/** Attaches names, so the group screen can label a link "Alice's link". */
async function withPeople(links: LinkSummary[]) {
  const ids = [...new Set(links.map((l) => l.userId).filter((id): id is string => id !== null))];
  const people = ids.length
    ? await db
        .selectFrom("users")
        .select(["id", "name", "nickname", "icon_letters", "icon_emoji", "icon_hue"])
        .where("id", "in", ids)
        .execute()
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));

  return links.map((link) => ({
    ...link,
    person: link.userId
      ? {
          id: link.userId,
          name: byId.get(link.userId)?.name ?? null,
          nickname: byId.get(link.userId)?.nickname ?? null,
          iconLetters: byId.get(link.userId)?.icon_letters ?? null,
          iconEmoji: byId.get(link.userId)?.icon_emoji ?? null,
          iconHue: byId.get(link.userId)?.icon_hue ?? null,
        }
      : null,
  }));
}

export const linkRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
/**
 * Links for one group, with the people they act as resolved.
 *
 * Any member may look: everyone in a group can already read every expense in
 * it, so knowing that a link exists tells them nothing they could not see. The
 * secret is not here, so this is not a way to get in.
 */
  .get(
    "/",
    zValidator(
      "query",
      z.object({ groupId: z.string().optional(), friendId: z.string().optional() }),
    ),
    async (c) => {
  const auth = c.get("user");
  const groupId = c.req.query("groupId");
  const friendId = c.req.query("friendId");

  if (groupId) {
    if (!isUlid(groupId)) return c.json({ error: "Invalid group id" }, 400);
    if (!(await membershipOf(groupId, auth.id))) {
      return c.json({ error: "Not a member of this group" }, 403);
    }
    return c.json({ links: await withPeople(await listGroupLinks(db, groupId)) });
  }

  if (friendId) {
    if (!isUlid(friendId)) return c.json({ error: "Invalid friend id" }, 400);
    const link = await findFriendLink(db, auth.id, friendId);
    return c.json({ links: link ? await withPeople([link]) : [] });
  }

  return c.json({ error: "Ask for groupId or friendId" }, 400);
})
/**
 * Mints a link, replacing whatever live one held the same slot.
 *
 * Mint and rotate are the same operation on purpose: there is at most one live
 * link per slot (enforced by partial unique indexes), so a "second" general
 * link for a group cannot exist, and the old secret dies in the same
 * transaction the new one is born in. No window where both work.
 */
  .post("/", zValidator("json", mintSchema), async (c) => {
  const auth = c.get("user");
  const input = c.req.valid("json");

  if (input.kind === "friend") {
    const related = await listRelatedUserIds(db, auth.id);
    if (!input.userId || !related.includes(input.userId)) {
      return c.json({ error: "That person is not on your friends list" }, 404);
    }
  } else {
    const membership = await membershipOf(input.groupId!, auth.id);
    if (!membership) return c.json({ error: "Not a member of this group" }, 403);
    if (membership.role !== "owner") {
      return c.json({ error: "Only the group owner can share this group" }, 403);
    }

    if (input.userId) {
      const member = await membershipOf(input.groupId!, input.userId);
      if (!member) return c.json({ error: "That person is not in this group" }, 404);
    }
  }

  try {
    const expiresAt = resolveLinkExpiry(input.expiresAt);
    const minted = await transaction((trx) =>
      mintAccessLink(trx, {
        kind: input.kind,
        groupId: input.kind === "friend" ? null : input.groupId!,
        userId: input.userId ?? null,
        createdBy: auth.id,
        expiresAt,
      }),
    );

    return c.json({ id: minted.id, url: minted.url, expiresAt }, 201);
  } catch (err) {
    if (err instanceof AccessLinkError) return c.json({ error: err.message }, 400);
    throw err;
  }
})
/** Revoke. Immediate: the secret is re-checked on every guest request. */
  .delete("/:id", async (c) => {
  const auth = c.get("user");
  const id = c.req.param("id");
  if (!isUlid(id)) return c.json({ error: "Invalid link id" }, 400);

  const link = await db
    .selectFrom("access_links")
    .select(["id", "kind", "group_id", "created_by"])
    .where("id", "=", id)
    .executeTakeFirst();

  if (!link) return c.json({ error: "Link not found" }, 404);

  if (link.kind === "friend") {
    if (link.created_by !== auth.id) return c.json({ error: "Not your link" }, 403);
  } else {
    const membership = await membershipOf(link.group_id!, auth.id);
    if (!membership || membership.role !== "owner") {
      return c.json({ error: "Only the group owner can turn off this link" }, 403);
    }
  }

  await revokeAccessLink(db, id);
  return c.json({ ok: true });
});
