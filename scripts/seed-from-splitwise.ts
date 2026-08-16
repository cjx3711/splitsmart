/**
 * Re-seeds categories and currencies from a real Splitwise export.
 *
 * WHY THIS EXISTS: the built-in seed (`npm run db:seed`) is a faithful
 * reconstruction of Splitwise's category tree, but the IDs are OURS. Any client
 * that hardcodes a Splitwise category_id — or any expense imported with one —
 * would land on the wrong category.
 *
 * This script fixes that by rewriting the categories table using Splitwise's
 * own ids, so `category_id` values are portable in both directions.
 *
 * Usage:
 *   npm run export:splitwise            # produces splitwise-export/<timestamp>/
 *   npm run seed:splitwise              # uses the most recent export
 *   npm run seed:splitwise -- <dir>     # or point at a specific one
 *
 * Safe to run before importing expenses. NOT safe to run after, if expenses
 * already reference the old category ids — the script refuses in that case.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/db/index.ts";
import { env } from "../src/env.ts";

interface SplitwiseCategory {
  id: number;
  name: string;
  icon?: string | null;
  subcategories?: SplitwiseCategory[];
}

interface SplitwiseCurrency {
  currency_code: string;
  unit?: string;
}

function findLatestExport(): string {
  const root = "splitwise-export";
  if (!existsSync(root)) {
    console.error(`No ${root}/ directory. Run \`npm run export:splitwise\` first.`);
    process.exit(1);
  }
  const dirs = readdirSync(root).sort();
  const latest = dirs[dirs.length - 1];
  if (!latest) {
    console.error(`${root}/ is empty. Run \`npm run export:splitwise\` first.`);
    process.exit(1);
  }
  return join(root, latest);
}

function readJson<T>(dir: string, name: string): T | null {
  const path = join(dir, `${name}.json`);
  if (!existsSync(path)) {
    console.warn(`  skip ${name}.json (not in export)`);
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function main(): void {
  const exportDir = process.argv[2] ?? findLatestExport();
  console.log(`Seeding from ${exportDir}\n`);

  const db = openDatabase(env.DATABASE_PATH);

  // Guard: rewriting category ids under existing expenses would silently
  // recategorise them. Refuse rather than corrupt.
  const inUse = db
    .prepare("SELECT COUNT(*) AS n FROM expenses WHERE category_id IS NOT NULL")
    .get() as { n: number };

  if (inUse.n > 0) {
    console.error(
      `Refusing to run: ${inUse.n} expense(s) already reference category ids.\n` +
        `Re-seeding would remap them. Run this on a fresh database, before importing expenses.`,
    );
    process.exit(1);
  }

  const categoryData = readJson<{ categories: SplitwiseCategory[] }>(exportDir, "categories");
  const currencyData = readJson<{ currencies: SplitwiseCurrency[] }>(exportDir, "currencies");

  const run = db.transaction(() => {
    if (categoryData?.categories?.length) {
      db.prepare("DELETE FROM categories").run();

      const insert = db.prepare(
        `INSERT INTO categories (id, splitwise_id, parent_id, name, icon, sort_order, is_default)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );

      let parentOrder = 0;
      let leafCount = 0;

      for (const parent of categoryData.categories) {
        insert.run(parent.id, parent.id, null, parent.name, parent.icon ?? null, parentOrder++, 0);

        let childOrder = 0;
        for (const child of parent.subcategories ?? []) {
          // Splitwise's fallback leaf is "Uncategorized > General"; mark
          // whatever plays that role so the compat layer has a default.
          const isDefault =
            /uncategor/i.test(parent.name) && /general/i.test(child.name) ? 1 : 0;
          insert.run(
            child.id,
            child.id,
            parent.id,
            child.name,
            child.icon ?? null,
            childOrder++,
            isDefault,
          );
          leafCount++;
        }
      }

      console.log(
        `  categories: ${categoryData.categories.length} parents, ${leafCount} leaves ` +
          `(using Splitwise ids)`,
      );

      // Keep future locally-created categories clear of Splitwise's id range.
      const maxId = db.prepare("SELECT MAX(id) AS m FROM categories").get() as { m: number };
      db.prepare(
        `INSERT INTO sqlite_sequence (name, seq) VALUES ('categories', ?)
         ON CONFLICT(name) DO UPDATE SET seq = MAX(seq, excluded.seq)`,
      ).run(maxId.m ?? 0);
    }

    if (currencyData?.currencies?.length) {
      // Splitwise's get_currencies does NOT report decimal places, so we keep
      // our ISO 4217 exponents and only add codes we were missing. Never let
      // this path overwrite decimal_places — that is the one field that must
      // stay authoritative.
      const insert = db.prepare(
        `INSERT OR IGNORE INTO currencies (code, decimal_places, symbol, name)
         VALUES (?, 2, ?, ?)`,
      );

      let added = 0;
      for (const currency of currencyData.currencies) {
        const code = currency.currency_code?.toUpperCase();
        if (!code || code.length !== 3) continue;
        const result = insert.run(code, currency.unit ?? null, code);
        if (result.changes > 0) {
          added++;
          console.log(`    + ${code} (assumed 2 decimals — verify if unusual)`);
        }
      }
      console.log(`  currencies: ${added} added from Splitwise, existing rows untouched`);
    }
  });

  run();

  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM categories) AS categories,
              (SELECT COUNT(*) FROM currencies) AS currencies`,
    )
    .get() as Record<string, number>;

  console.log(`\nNow: ${counts.categories} categories, ${counts.currencies} currencies`);
  db.close();
}

main();
