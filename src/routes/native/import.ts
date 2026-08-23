/**
 * Splitwise import endpoints.
 *
 * The wizard in web/src/pages/Import.tsx is a thin shell over these: it collects
 * an API key and then drives one endpoint per step. That split is deliberate -
 * every step is an ordinary authenticated JSON request, so the whole import can
 * be exercised with curl, by a test, or by an agent, with no browser involved.
 *
 * THE API KEY IS NEVER STORED. It is sent on each request that needs it, used
 * for that request, and dropped. There is no column for it and no background
 * job holding it. The cost is that the client resends it per step; the benefit
 * is that a database dump of this app contains no credential to anyone else's
 * Splitwise account.
 *
 * Order matters and is enforced by the data, not by a state machine: expenses
 * reference groups, groups reference people. Call them in the documented order
 * or `/expenses` will hand back skips saying which group is missing.
 *
 *   GET  /api/v1/import/status    what is already here (no key needed)
 *   POST /api/v1/import/preview   dry run: reads Splitwise, writes nothing
 *   POST /api/v1/import/friends   step 1
 *   POST /api/v1/import/groups    step 2
 *   POST /api/v1/import/expenses  step 3, one page per call
 *   POST /api/v1/import/comments         step 4, one page of expenses per call
 *   POST /api/v1/import/rounding         step 5, settle leftover cents vs Splitwise
 *   POST /api/v1/import/continue-recurring  resume stopped imported series
 *   POST /api/v1/import/run              all five server-side, for small accounts
 *   POST /api/v1/import/wipe             hard-delete this account's ledger (reimport)
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../../db/index.ts";
import { ulid } from "../../domain/ulid.ts";
import { requireAuth, type AppEnv } from "../../auth/middleware.ts";
import { SplitwiseClient, SplitwiseError, SplitwiseAuthError } from "../../splitwise/client.ts";
import {
  previewImport,
  importFriends,
  importGroups,
  importExpensePage,
  importCommentsPage,
  continueImportedRepeats,
  localFootprint,
  reconcileImportedBalances,
  type CommentsPageResult,
  type ExpensePageResult,
  type PausedImportedSeries,
  type RoundingResult,
  type SkippedRow,
} from "../../domain/import.ts";
import { wipeUserLedger, WipeBlockedError, WIPE_CONFIRMATION } from "../../domain/wipe.ts";

const keySchema = z.object({
  // Splitwise personal keys are opaque; only the obvious junk is rejected here
  // so a real "your key is wrong" answer comes from Splitwise, not from us.
  apiKey: z.string().trim().min(10, "That does not look like a Splitwise API key."),
});

function clientFor(apiKey: string): SplitwiseClient {
  return new SplitwiseClient({ apiKey, requestDelayMs: 150 });
}

/**
 * Turns an upstream failure into a status the wizard can act on.
 *
 * A bad key is 400 (fix your input), everything else upstream is 502 (not your
 * fault, try again). Anything unrecognised is re-thrown to the global handler
 * rather than flattened into a misleading 502.
 */
function upstreamError(err: unknown): { status: 400 | 429 | 502; error: string } | null {
  if (err instanceof SplitwiseAuthError) return { status: 400, error: err.message };
  if (err instanceof SplitwiseError) {
    return { status: err.status === 429 ? 429 : 502, error: err.message };
  }
  return null;
}

async function withUpstream<T>(
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; status: 400 | 429 | 502; error: string }> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    const mapped = upstreamError(err);
    if (!mapped) throw err;
    return { ok: false, ...mapped };
  }
}

const expensePageSchema = keySchema.extend({
  offset: z.number().int().min(0).default(0),
  // Splitwise caps this server-side anyway; the ceiling here just stops a
  // client asking for a page that takes minutes to come back.
  limit: z.number().int().min(1).max(100).default(100),
});

/**
 * Step 4: comments, for the expenses already imported.
 *
 * A separate step because `comments.expense_id` is a foreign key, so this cannot
 * run before step 3. It is a no-op when Splitwise nested the comments on the
 * expense payload (they were imported with the expense and each row is stamped as
 * synced), which is why the wizard can always call it and never has to know which
 * shape this Splitwise deployment speaks.
 */
const commentPageSchema = keySchema.extend({
  offset: z.number().int().min(0).default(0),
  // Lower than the expense page size on purpose: this may be one upstream request
  // PER EXPENSE, with a courtesy delay between them.
  limit: z.number().int().min(1).max(50).default(25),
});

/**
 * Everything, in order, in one request.
 *
 * Exists because the step-by-step flow is tedious to drive from a script and
 * because most self-hosted accounts are small enough to finish inside a normal
 * request. It is capped rather than unbounded: past the cap the response says
 * so and hands back the offset to resume from, which is exactly what the paged
 * endpoint expects.
 */
const runSchema = keySchema.extend({
  maxPages: z.number().int().min(1).max(200).default(50),
});

/**
 * One feed entry per import call, not per expense.
 *
 * `createExpense` is told to skip its own activity row during an import (see
 * its `recordActivity` option), because a thousand imported expenses would
 * otherwise push every real event off the feed.
 */
async function recordImportActivity(userId: string, count: number): Promise<void> {
  await db
    .insertInto("activity")
    .values({
      id: ulid(),
      user_id: userId,
      action: "import.completed",
      payload: JSON.stringify({ source: "splitwise", expenses: count }),
    })
    .execute();
}

export const importRoutes = new Hono<AppEnv>()
  .use("*", requireAuth)
/**
 * Rejects guests.
 *
 * A ghost has no email and no way back into their own account; letting one
 * absorb a real Splitwise history would strand that history behind a single
 * session cookie.
 */
  .use("*", async (c, next) => {
  if (c.get("user").isGhost) {
    return c.json({ error: "Guest accounts cannot import from Splitwise." }, 403);
  }
  await next();
})
/** No key required: this is what the wizard shows before asking for one. */
  .get("/status", async (c) => {
  const auth = c.get("user");
  const local = await localFootprint(auth.id);

  return c.json({
    local,
    hasData: local.groups > 0 || local.friends > 0 || local.expenses > 0,
    previouslyImported: local.previouslyImported > 0,
    /**
     * Shown verbatim in the wizard. Kept server-side so the API and the UI
     * cannot end up promising different matching behaviour.
     */
    matchingRule:
      "People from Splitwise are matched to existing SplitSmart accounts by Splitwise id, then by email address. " +
      "Anyone with no matching account is created as a placeholder person you can invite later. " +
      "Groups and expenses are unique on Splitwise id, so a friend's later import joins what is already here.",
  });
})
  .post("/preview", zValidator("json", keySchema), async (c) => {
  const auth = c.get("user");
  const result = await withUpstream(() =>
    previewImport(clientFor(c.req.valid("json").apiKey), auth.id),
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.value);
})
  .post("/friends", zValidator("json", keySchema), async (c) => {
  const auth = c.get("user");
  const result = await withUpstream(() =>
    importFriends(clientFor(c.req.valid("json").apiKey), auth.id),
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.value);
})
  .post("/groups", zValidator("json", keySchema), async (c) => {
  const auth = c.get("user");
  const result = await withUpstream(() =>
    importGroups(clientFor(c.req.valid("json").apiKey), auth.id),
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.value);
})
  .post("/expenses", zValidator("json", expensePageSchema), async (c) => {
  const auth = c.get("user");
  const { apiKey, offset, limit } = c.req.valid("json");

  const result = await withUpstream(() =>
    importExpensePage(clientFor(apiKey), auth.id, { offset, limit }),
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);

  if (result.value.imported > 0) await recordImportActivity(auth.id, result.value.imported);
  return c.json(result.value);
})
  .post("/comments", zValidator("json", commentPageSchema), async (c) => {
  const auth = c.get("user");
  const { apiKey, offset, limit } = c.req.valid("json");

  const result = await withUpstream(() =>
    importCommentsPage(clientFor(apiKey), auth.id, { offset, limit }),
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);

  return c.json(result.value);
})
  .post("/rounding", zValidator("json", keySchema), async (c) => {
  const auth = c.get("user");
  const result = await withUpstream(() =>
    reconcileImportedBalances(clientFor(c.req.valid("json").apiKey), auth.id),
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.value);
})
  .post("/run", zValidator("json", runSchema), async (c) => {
  const auth = c.get("user");
  const { apiKey, maxPages } = c.req.valid("json");
  const client = clientFor(apiKey);

  const result = await withUpstream(async () => {
    const friends = await importFriends(client, auth.id);
    const groups = await importGroups(client, auth.id);

    const pages: ExpensePageResult[] = [];
    let imported = 0;
    let alreadyPresent = 0;
    let refreshed = 0;
    let commentsImported = 0;
    const skipped: SkippedRow[] = [];
    const warnings: SkippedRow[] = [];
    const pausedSeries: PausedImportedSeries[] = [];
    let offset = 0;
    let complete = false;

    for (let page = 0; page < maxPages; page++) {
      const result = await importExpensePage(client, auth.id, { offset });
      pages.push(result);
      imported += result.imported;
      alreadyPresent += result.alreadyPresent;
      refreshed += result.refreshed;
      commentsImported += result.commentsImported;
      skipped.push(...result.skipped);
      warnings.push(...result.warnings);
      pausedSeries.push(...result.pausedSeries);

      if (result.done || result.nextOffset === null) {
        complete = true;
        break;
      }
      offset = result.nextOffset;
    }

    // Comments last, because they reference the expenses above. A no-op when
    // Splitwise already nested them; only walked when it did not.
    const comments = { imported: commentsImported, skipped: [] as SkippedRow[], complete: true };
    if (complete) {
      let commentOffset: number | null = 0;
      for (let page = 0; page < maxPages && commentOffset !== null; page++) {
        const result: CommentsPageResult = await importCommentsPage(client, auth.id, {
          offset: commentOffset,
        });
        comments.imported += result.imported;
        comments.skipped.push(...result.skipped);
        commentOffset = result.done ? null : result.nextOffset;
      }
      comments.complete = commentOffset === null;
    } else {
      // Expenses are not all in yet, so walking comments would miss the ones
      // hanging off bills this run has not fetched.
      comments.complete = false;
    }

    let rounding: RoundingResult | null = null;
    if (complete && comments.complete) {
      rounding = await reconcileImportedBalances(client, auth.id);
    }

    return {
      friends,
      groups,
      expenses: {
        imported,
        alreadyPresent,
        refreshed,
        skipped,
        warnings,
        pausedSeries,
        pages: pages.length,
        // False means the cap was hit, not that anything failed. Call
        // /import/expenses with this offset to carry on.
        complete,
        nextOffset: complete ? null : offset,
      },
      comments,
      rounding,
    };
  });

  if (!result.ok) return c.json({ error: result.error }, result.status);

  if (result.value.expenses.imported > 0) {
    await recordImportActivity(auth.id, result.value.expenses.imported);
  }
  return c.json(result.value);
})
  /**
   * Resume Splitwise repeating bills that import landed as stopped series.
   *
   * Same resume as the expense page: starts from today, does not backfill.
   * No API key: the rows are already here. Unknown or unseen ids are skipped
   * rather than failing the batch.
   */
  .post(
    "/continue-recurring",
    zValidator(
      "json",
      z.object({
        ids: z.array(z.string()).max(200),
      }),
    ),
    async (c) => {
      const auth = c.get("user");
      return c.json(await continueImportedRepeats(auth.id, c.req.valid("json").ids));
    },
  )
  /**
   * Hard-delete this account's groups, expenses, friendships and placeholder
   * people so a Splitwise import can run on an empty book. The account itself
   * is left alone. Refuses if another live real account shares the data.
   *
   * Confirmation is in the body so a stray POST cannot do this; the UI also
   * asks twice, the second time by typing the same phrase.
   */
  .post(
    "/wipe",
    zValidator("json", z.object({ confirm: z.literal(WIPE_CONFIRMATION) })),
    async (c) => {
  try {
    return c.json(await wipeUserLedger(c.get("user").id));
  } catch (err) {
    if (err instanceof WipeBlockedError) {
      return c.json({ error: err.message, others: err.others }, 409);
    }
    throw err;
  }
});
