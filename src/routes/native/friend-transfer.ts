import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import { executeFriendTransfer, previewFriendTransfer, FriendTransferError } from "../../domain/friend-transfer.ts";
import { ulidSchema } from "./expense-schema.ts";

const inputSchema = z.object({
  targetId: ulidSchema,
  mode: z.enum(["merge", "transfer"]),
  scope: z.enum(["all", "personal", "group"]),
  groupId: ulidSchema.optional(),
});

export const friendTransferRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
  .onError((error, c) => {
    if (error instanceof FriendTransferError) return c.json({ error: error.message }, error.status);
    throw error;
  })
  .post("/:id/transfer/preview", zValidator("param", z.object({ id: ulidSchema })), zValidator("json", inputSchema), async (c) => {
    return c.json(await previewFriendTransfer(c.get("user").id, c.req.valid("param").id, c.req.valid("json")));
  })
  .post("/:id/transfer", zValidator("param", z.object({ id: ulidSchema })), zValidator("json", inputSchema.extend({
    confirmed: z.literal(true),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })), async (c) => {
    const { confirmed: _confirmed, fingerprint, ...input } = c.req.valid("json");
    return c.json(await executeFriendTransfer(c.get("user").id, c.req.valid("param").id, input, fingerprint));
  });
