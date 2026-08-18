/**
 * Native comment routes.
 *
 *   GET    /api/v1/expenses/:id/comments
 *   POST   /api/v1/expenses/:id/comments   { content }
 *   DELETE /api/v1/comments/:id
 *
 * Two routers because the collection hangs off an expense and the item does not:
 * a comment id is enough to find a comment, and making the client repeat the
 * expense id would just be a second thing to get wrong.
 *
 * THE HTTP LAYER CANNOT WRITE A SYSTEM COMMENT. There is no `kind` in the body
 * schema and no route that accepts one; generated rows come from
 * src/domain/comments.ts when an expense is edited, deleted or restored. The
 * guest versions of these three live in src/routes/native/guest.ts, scoped to
 * the link, and go through the same domain functions.
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import {
  CommentError,
  MAX_COMMENT_LENGTH,
  canSeeExpense,
  createComment,
  deleteComment,
  listComments,
  type CommentRecord,
} from "../../domain/comments.ts";
import { isUlid } from "../../domain/ulid.ts";
import { ulidSchema } from "./expense-schema.ts";

/** The wire shape, shared with the guest tree so both shells parse one thing. */
export function serializeComment(comment: CommentRecord) {
  return {
    id: comment.id,
    expenseId: comment.expenseId,
    kind: comment.kind,
    content: comment.content,
    createdAt: comment.createdAt,
    author: comment.author,
  };
}

export const commentBodySchema = z.object({
  content: z.string().min(1).max(MAX_COMMENT_LENGTH),
  /** Client-minted ULID, for offline replay. Absent: the server mints one. */
  id: ulidSchema.optional(),
});

/** Maps a CommentError onto its status; anything else is a real 500. */
export function commentErrorResponse(err: unknown): { status: 400 | 403 | 404; error: string } {
  if (err instanceof CommentError) return { status: err.status, error: err.message };
  throw err;
}

// --- mounted at /api/v1/expenses --------------------------------------------

// --- mounted at /api/v1/comments --------------------------------------------

export const expenseCommentRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/:id/comments", async (c) => {
  const auth = c.get("user");
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  // Same visibility as GET /expenses/:id, and the same 404 for anything else, so
  // a stranger cannot tell an expense they cannot see from one that is not there.
  if (!(await canSeeExpense(db, expenseId, auth.id))) return c.json({ error: "Not found" }, 404);

  const comments = await listComments(db, expenseId);
  return c.json({ comments: comments.map(serializeComment) });
})
  .post("/:id/comments", zValidator("json", commentBodySchema), async (c) => {
  const auth = c.get("user");
  const expenseId = c.req.param("id");
  if (!isUlid(expenseId)) return c.json({ error: "Invalid expense id" }, 400);

  const input = c.req.valid("json");

  try {
    const id = await createComment({
      id: input.id,
      expenseId,
      userId: auth.id,
      content: input.content,
      // Never from the request. See the note at the top of this file.
      kind: "user",
    });
    const comments = await listComments(db, expenseId);
    const created = comments.find((comment) => comment.id === id);
    return c.json({ comment: created ? serializeComment(created) : null }, 201);
  } catch (err) {
    const mapped = commentErrorResponse(err);
    return c.json({ error: mapped.error }, mapped.status);
  }
});
export const commentRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .delete("/:id", async (c) => {
  const auth = c.get("user");
  const commentId = c.req.param("id");
  if (!isUlid(commentId)) return c.json({ error: "Invalid comment id" }, 400);

  try {
    await deleteComment(commentId, auth.id);
    return c.json({ ok: true });
  } catch (err) {
    const mapped = commentErrorResponse(err);
    return c.json({ error: mapped.error }, mapped.status);
  }
});
