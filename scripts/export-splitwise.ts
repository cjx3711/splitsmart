/**
 * Splitwise raw export.
 *
 * DO THIS BEFORE ANYTHING ELSE. Splitwise is moving its API behind a paywall,
 * and once that lands this data is unreachable.
 *
 * Deliberately dumps RAW, UNTRANSFORMED JSON to disk. It does not touch the
 * database. The schema here will change many times while the app is built, and
 * each change would otherwise mean re-hitting an API that may no longer be
 * free. A raw snapshot makes re-import free and repeatable forever.
 *
 * Usage:
 *   SPLITWISE_API_KEY=... yarn export:splitwise
 *
 * Output: splitwise-export/<timestamp>/*.json  (gitignored; contains personal
 * financial data; back it up somewhere private.)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API_BASE = "https://secure.splitwise.com/api/v3.0";
const PAGE_SIZE = 100;
/** Courtesy delay between requests so a full export doesn't look like abuse. */
const REQUEST_DELAY_MS = 250;

const apiKey = process.env.SPLITWISE_API_KEY;
if (!apiKey) {
  console.error("SPLITWISE_API_KEY is not set.");
  console.error("Get a personal API key from https://secure.splitwise.com/apps");
  process.exit(1);
}

const outDir = join(
  "splitwise-export",
  new Date().toISOString().replace(/[:.]/g, "-"),
);

async function get(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });

  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}\n${await res.text()}`);
  }
  return res.json();
}

function save(name: string, data: unknown): void {
  const path = join(outDir, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
  console.log(`  saved ${path}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pulls every expense by walking offset until a short page comes back.
 *
 * Splitwise caps page size server-side, so trust the returned length rather
 * than assuming the requested limit was honoured.
 */
async function fetchAllExpenses(): Promise<unknown[]> {
  const all: unknown[] = [];
  let offset = 0;

  for (;;) {
    const page = (await get(
      `/get_expenses?limit=${PAGE_SIZE}&offset=${offset}`,
    )) as { expenses?: unknown[] };

    const batch = page.expenses ?? [];
    all.push(...batch);
    console.log(`  fetched ${all.length} expenses...`);

    if (batch.length < PAGE_SIZE) break;
    offset += batch.length;
    await sleep(REQUEST_DELAY_MS);

    if (offset > 100_000) {
      console.warn("  stopping at 100k expenses; raise the cap if you really have more");
      break;
    }
  }

  return all;
}

/**
 * Comments, per expense, for every expense that says it has some.
 *
 * The expenses dump above ALREADY contains them if this Splitwise deployment
 * nests `comments[]` on the list payload. It may not — it may only send
 * `comments_count` — and that is the whole reason this walk exists: comments are
 * the only edit history Splitwise will ever hand over ("Jane updated this
 * transaction: the cost changed from 6.99 to 8.99"), and once the API is behind a
 * paywall that history is gone.
 *
 * Saved RAW, keyed by expense id, like everything else here. One request per
 * expense with a courtesy delay, so this is the slow part after expenses.
 */
async function fetchComments(
  expenses: unknown[],
): Promise<{ byExpense: Record<string, unknown>; nested: number; fetched: number }> {
  const byExpense: Record<string, unknown> = {};
  let nested = 0;
  let fetched = 0;

  for (const raw of expenses) {
    const expense = raw as {
      id?: number;
      comments_count?: number;
      comments?: unknown[];
    };
    if (!expense.id) continue;

    if (Array.isArray(expense.comments) && expense.comments.length > 0) {
      // Already in the expenses dump. Copied here too so one file answers
      // "what were the comments" without re-deriving it from the other.
      byExpense[String(expense.id)] = { comments: expense.comments, source: "nested" };
      nested++;
      continue;
    }

    if (!expense.comments_count) continue;

    try {
      byExpense[String(expense.id)] = {
        ...(await get(`/get_comments?expense_id=${expense.id}`) as object),
        source: "get_comments",
      };
      fetched++;
      if (fetched % 25 === 0) console.log(`  fetched comments for ${fetched} expenses...`);
    } catch (err) {
      // One expense's comments are not worth aborting the run over.
      console.warn(
        `  WARN comments for expense ${expense.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await sleep(REQUEST_DELAY_MS);
  }

  return { byExpense, nested, fetched };
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  console.log(`Exporting Splitwise data to ${outDir}\n`);

  // Fetch the cheap endpoints first so a failure partway through still leaves
  // the small, hard-to-reconstruct reference data on disk.
  const steps: Array<[name: string, fn: () => Promise<unknown>]> = [
    ["current_user", () => get("/get_current_user")],
    ["groups", () => get("/get_groups")],
    ["friends", () => get("/get_friends")],
    ["categories", () => get("/get_categories")],
    ["currencies", () => get("/get_currencies")],
    ["notifications", () => get("/get_notifications?limit=0")],
  ];

  for (const [name, fn] of steps) {
    try {
      save(name, await fn());
    } catch (err) {
      // A single missing endpoint must not abort the run; the expenses dump
      // below is the irreplaceable part.
      console.warn(`  WARN ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(REQUEST_DELAY_MS);
  }

  console.log("\nFetching expenses (this is the slow part)...");
  const expenses = await fetchAllExpenses();
  save("expenses", { expenses });

  console.log("\nFetching comments for expenses that have them...");
  const comments = await fetchComments(expenses);
  save("comments", { byExpense: comments.byExpense });

  save("_meta", {
    exportedAt: new Date().toISOString(),
    apiBase: API_BASE,
    expenseCount: expenses.length,
    // Recorded because it answers the open question in docs/PARITY.md: whether
    // the expenses dump alone is a complete comment backup for this account.
    commentsNestedOnExpenses: comments.nested,
    commentsFetchedSeparately: comments.fetched,
    note: "Raw unmodified Splitwise API responses. Input to the in-app importer (/import).",
  });

  console.log(
    `\nComments: ${comments.nested} expense(s) already carried them on the list, ` +
      `${comments.fetched} needed their own request.`,
  );
  console.log(`Done. ${expenses.length} expenses saved to ${outDir}`);
  console.log("Back this directory up somewhere private; it is gitignored.");
}

main().catch((err) => {
  console.error("\nExport failed:", err instanceof Error ? err.message : err);
  console.error("Partial data (if any) is still in", outDir);
  process.exit(1);
});
