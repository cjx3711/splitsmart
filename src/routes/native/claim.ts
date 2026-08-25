/**
 * Claim: "that placeholder is me."
 *
 * ONE FLOW, deliberately. You create a real account first (register, cookie
 * session), then, still holding the guest link, you claim the ghost it acts as.
 * There is no "set a password on the ghost" path: two ways to reach the same
 * outcome is one way too many, and the in-place upgrade could never handle the
 * case where you already had an account.
 *
 * These endpoints live on the LOGGED-IN tree and need BOTH:
 *
 *   a cookie session   who you are
 *   a link token       what makes those ghosts claimable
 *
 * The token is the whole authorisation. Without it a logged-in user could eat
 * any placeholder in the database by id, which is a way to attach yourself to
 * strangers' money. With it, they can only claim someone the link could
 * already act as, which they could already read and write as anyway.
 *
 * The merge itself is src/domain/merge.ts, and it never moves a balance.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import {
  inspectClaimLink,
  listActablePeople,
  failureMessage,
  type AccessLinkRecord,
} from "../../domain/access-links.ts";
import { previewMerge, mergeUsers, MergeError } from "../../domain/merge.ts";
import { ulidSchema } from "./expense-schema.ts";
import { personCamel } from "../../domain/person.ts";

const tokenSchema = z.object({ linkToken: z.string().min(1) });

const claimSchema = tokenSchema.extend({ userId: ulidSchema });

/**
 * Checks the link really covers this person before anything is read or written.
 *
 * Shared by preview and confirm so the two cannot disagree about who is
 * claimable; a preview of one merge followed by a different merge would be the
 * worst possible bug in this file.
 */
async function authoriseClaim(
  linkToken: string,
  authUserId: string,
  targetUserId: string,
): Promise<{ ok: true } | { ok: false; status: 400 | 403 | 409; error: string }> {
  const inspected = await inspectClaimLink(linkToken, authUserId);
  if (inspected.status === "failed") {
    return { ok: false, status: 400, error: failureMessage(inspected.reason) };
  }
  if (inspected.status === "already_claimed") {
    return { ok: false, status: 409, error: "You already claimed this." };
  }

  const actable = await listActablePeople(db, inspected.link);
  if (!actable.some((p) => p.id === targetUserId)) {
    return {
      ok: false,
      status: 403,
      error: "This link cannot claim that person.",
    };
  }

  return { ok: true };
}

async function claimDestinations(link: AccessLinkRecord): Promise<{
  kind: AccessLinkRecord["kind"];
  group: { id: string; name: string } | null;
  counterpart: ReturnType<typeof personCamel> & { id: string } | null;
}> {
  const counterpart =
    link.kind === "friend"
      ? await db
          .selectFrom("users")
          .select(["id", "name", "nickname", "icon_letters", "icon_emoji", "icon_hue", "icon_pattern"])
          .where("id", "=", link.createdBy)
          .executeTakeFirst()
      : undefined;
  const group = link.groupId
    ? await db
        .selectFrom("groups")
        .select(["id", "name"])
        .where("id", "=", link.groupId)
        .executeTakeFirst()
    : null;
  return {
    kind: link.kind,
    group: group ?? null,
    counterpart: counterpart ? { id: counterpart.id, ...personCamel(counterpart) } : null,
  };
}

export const claimRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
/**
 * Resolves a guest link for a signed-in caller and returns the people it makes
 * claimable, or the reason it cannot.
 *
 * Four outcomes, and the UI needs all four:
 *
 *   already_member   they are in this group as themselves. No picker.
 *   already_claimed  they already absorbed the person this link bound. The
 *                    success screen; a stranger with the same URL gets 400
 *                    invalid instead, so the token does not advertise that
 *                    a real account sits behind it.
 *   claimable        a list of unclaimed ghosts the link can act as.
 *   none             the link works, but everyone it covers is already taken.
 */
  .post("/candidates", zValidator("json", tokenSchema), async (c) => {
  const auth = c.get("user");
  const inspected = await inspectClaimLink(c.req.valid("json").linkToken, auth.id);

  if (inspected.status === "failed") {
    return c.json({ error: failureMessage(inspected.reason), reason: inspected.reason }, 400);
  }

  const dest = await claimDestinations(inspected.link);

  if (inspected.status === "already_claimed") {
    return c.json({
      status: "already_claimed" as const,
      ...dest,
      candidates: [],
    });
  }

  const link = inspected.link;

  if (link.groupId) {
    const membership = await db
      .selectFrom("group_members")
      .select("user_id")
      .where("group_id", "=", link.groupId)
      .where("user_id", "=", auth.id)
      .where("left_at", "is", null)
      .executeTakeFirst();

    if (membership) {
      return c.json({
        status: "already_member" as const,
        ...dest,
        candidates: [],
      });
    }
  }

  const candidates = await listActablePeople(db, link);

  return c.json({
    status: candidates.length > 0 ? ("claimable" as const) : ("none" as const),
    ...dest,
    candidates,
  });
})
/**
 * What the merge would do, in the words the confirm dialog shows.
 *
 * Combining two people's shares on one bill is not undoable from the UI, so it
 * is never silent: the count, and the descriptions when there are few enough to
 * read, go in front of the user before anything happens.
 */
  .post("/preview", zValidator("json", claimSchema), async (c) => {
  const auth = c.get("user");
  const { linkToken, userId } = c.req.valid("json");

  if (userId === auth.id) return c.json({ error: "That is already you." }, 400);

  const allowed = await authoriseClaim(linkToken, auth.id, userId);
  if (!allowed.ok) return c.json({ error: allowed.error }, allowed.status);

  const person = await db
    .selectFrom("users")
    .select(["id", "name", "nickname", "icon_letters", "icon_emoji", "icon_hue", "icon_pattern"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!person) return c.json({ error: "That person no longer exists" }, 404);

  const preview = await previewMerge(db, userId, auth.id);

  return c.json({
    person: { id: person.id, ...personCamel(person) },
    // The list is for the "a handful" case; the count is what always matters.
    // Ten descriptions is a paragraph, not a confirmation.
    overlapping: preview.overlapping.slice(0, 10),
    overlappingCount: preview.overlapping.length,
    transferredCount: preview.transferredCount,
    sharedGroupCount: preview.sharedGroupCount,
    linkCount: preview.linkCount,
  });
})
/** Runs the merge. Everything in one transaction; see src/domain/merge.ts. */
  .post("/", zValidator("json", claimSchema), async (c) => {
  const auth = c.get("user");
  const { linkToken, userId } = c.req.valid("json");

  if (userId === auth.id) return c.json({ error: "That is already you." }, 400);

  const allowed = await authoriseClaim(linkToken, auth.id, userId);
  if (!allowed.ok) return c.json({ error: allowed.error }, allowed.status);

  try {
    const result = await mergeUsers(userId, auth.id);
    return c.json({ ok: true, ...result });
  } catch (err) {
    if (err instanceof MergeError) return c.json({ error: err.message }, 409);
    throw err;
  }
});
