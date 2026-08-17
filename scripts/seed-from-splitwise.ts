/**
 * Refreshes categories and currencies from a Splitwise export.
 *
 * NOT normally needed. `yarn db:seed` already uses Splitwise's real category
 * ids, captured from the live API and checked in at
 * fixtures/splitwise/get_categories.json (with src/db/categories.test.ts
 * diffing the two).
 *
 * This script exists for the case where Splitwise's tree has CHANGED since that
 * capture and you have a newer export. For a first-time setup, just run
 * `yarn db:seed`.
 *
 * Usage:
 *   yarn export:splitwise            # produces splitwise-export/<timestamp>/
 *   yarn seed:splitwise              # uses the most recent export
 *   yarn seed:splitwise -- <dir>     # or point at a specific one
 *
 * Safe to run before importing expenses. NOT safe to run after, if expenses
 * already reference the old category ids; the script refuses in that case.
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
    console.error(`No ${root}/ directory. Run \`yarn export:splitwise\` first.`);
    process.exit(1);
  }
  const dirs = readdirSync(root).sort();
  const latest = dirs[dirs.length - 1];
  if (!latest) {
    console.error(`${root}/ is empty. Run \`yarn export:splitwise\` first.`);
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

      // No sqlite_sequence bump needed; AUTOINCREMENT raises the stored
      // sequence to any explicit id inserted above. (sqlite_sequence has no
      // UNIQUE constraint, so ON CONFLICT against it is not even valid SQL.)
      const maxId = db.prepare("SELECT MAX(id) AS m FROM categories").get() as { m: number };
      const seq = db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'categories'")
        .get() as { seq: number } | undefined;

      if ((seq?.seq ?? 0) < (maxId.m ?? 0)) {
        throw new Error(
          `categories sequence is ${seq?.seq ?? 0}, expected >= ${maxId.m}. ` +
            `New categories could collide with Splitwise ids.`,
        );
      }
    }

    if (currencyData?.currencies?.length) {
      // Splitwise's get_currencies does NOT report decimal places, so we keep
      // our ISO 4217 exponents and only add codes we were missing. Never let
      // this path overwrite decimal_places; that is the one field that must
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
          console.log(`    + ${code} (assumed 2 decimals; verify if unusual)`);
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
