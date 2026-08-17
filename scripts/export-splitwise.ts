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

  save("_meta", {
    exportedAt: new Date().toISOString(),
    apiBase: API_BASE,
    expenseCount: expenses.length,
    note: "Raw unmodified Splitwise API responses. Input to scripts/import-splitwise.ts.",
  });

  console.log(`\nDone. ${expenses.length} expenses saved to ${outDir}`);
  console.log("Back this directory up somewhere private; it is gitignored.");
}

main().catch((err) => {
  console.error("\nExport failed:", err instanceof Error ? err.message : err);
  console.error("Partial data (if any) is still in", outDir);
  process.exit(1);
});
