/**
 * The typed native API, composed so the web client can use `hc<NativeApi>()`.
 *
 * Mounted at `/api/v1` by src/server.ts. Guest routes are a sibling, registered
 * first, so this router must not carry a wildcard `requireAuth` - that would
 * wrap `/api/v1/guest/*`, whose whole point is to live outside it.
 */
import { Hono } from "hono";
import type { AppEnv } from "../../auth/middleware.ts";
import { authRoutes } from "./auth.ts";
import { claimRoutes } from "./claim.ts";
import { linkRoutes } from "./links.ts";
import { groupRoutes, expenseRoutes, categoryRoutes } from "./groups.ts";
import { friendRoutes } from "./friends.ts";
import { activityRoutes } from "./activity.ts";
import { importRoutes } from "./import.ts";
import { commentRoutes, expenseCommentRoutes } from "./comments.ts";
import { exportRoutes } from "./export.ts";
import { syncRoutes } from "./sync.ts";
import { adminRoutes } from "./admin.ts";

export const nativeApi = new Hono<AppEnv>()
  .route("/auth", authRoutes)
  .route("/claim", claimRoutes)
  .route("/links", linkRoutes)
  .route("/groups", groupRoutes)
  .route("/friends", friendRoutes)
  .route("/expenses", expenseRoutes)
  .route("/expenses", expenseCommentRoutes)
  .route("/comments", commentRoutes)
  .route("/activity", activityRoutes)
  .route("/categories", categoryRoutes)
  .route("/import", importRoutes)
  .route("/sync", syncRoutes)
  .route("/admin", adminRoutes)
  .route("/", exportRoutes);

export type NativeApi = typeof nativeApi;
