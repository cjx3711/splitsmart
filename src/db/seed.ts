/**
 * Seeds reference data: currencies, Splitwise's category tree, and the native
 * extras that sit above Splitwise's id space (see EXTRA_* in categories.ts).
 *
 * Idempotent; safe to re-run.
 *
 * SPLITWISE CATEGORY IDS ARE THE REAL IDS, captured from the live API and kept
 * at fixtures/splitwise/get_categories.json. That matters because `category_id`
 * is what an imported expense or a client carrying a Splitwise id has to land
 * on. The ids are
 * non-sequential and share one space between parents and children, so they are
 * inserted explicitly rather than autoincremented. Extras start at 51.
 *
 * Usage:  yarn db:seed
 */
import type SQLite from "better-sqlite3";
import { openDatabase } from "./index.ts";
import { env } from "../env.ts";
import { CURRENCIES } from "./currencies.ts";
import {
  CATEGORIES,
  DEFAULT_CATEGORY_ID,
  EXTRA_LEAVES,
  EXTRA_PARENTS,
  MAX_SEEDED_CATEGORY_ID,
} from "./categories.ts";

/**
 * Native-only categories (ids ≥ 51). Shared with seed-from-splitwise so a
 * refresh of the Splitwise tree does not wipe the extras we added on top.
 */
export function seedExtraCategories(db: SQLite.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO categories
       (id, splitwise_id, parent_id, name, icon, sort_order, is_default)
     VALUES (?, NULL, ?, ?, NULL, ?, 0)`,
  );
  EXTRA_PARENTS.forEach((parent, parentIndex) => {
    insert.run(parent.id, null, parent.name, 100 + parentIndex);
    parent.children.forEach((child, childIndex) => {
      insert.run(child.id, parent.id, child.name, childIndex);
    });
  });
  EXTRA_LEAVES.forEach((child, childIndex) => {
    insert.run(child.id, child.parentId, child.name, 100 + childIndex);
  });
}

export function seed(databasePath: string = env.DATABASE_PATH): void {
  const db = openDatabase(databasePath);

  const insertCurrency = db.prepare(
    `INSERT INTO currencies (code, decimal_places, symbol, name)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(code) DO UPDATE SET
       decimal_places = excluded.decimal_places,
       symbol = COALESCE(currencies.symbol, excluded.symbol),
       name   = COALESCE(currencies.name, excluded.name)`,
  );

  const insertCategory = db.prepare(
    `INSERT OR IGNORE INTO categories
       (id, splitwise_id, parent_id, name, icon, sort_order, is_default)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`,
  );

  const run = db.transaction(() => {
    for (const currency of CURRENCIES) {
      // decimal_places is force-updated rather than ignored: it is the one
      // field where a stale value silently corrupts money, so the code here is
      // always authoritative over whatever is in the database.
      insertCurrency.run(currency.code, currency.decimals, currency.symbol, currency.name);
    }

    CATEGORIES.forEach((parent, parentIndex) => {
      insertCategory.run(parent.id, parent.id, null, parent.name, parentIndex, 0);

      parent.children.forEach((child, childIndex) => {
        insertCategory.run(
          child.id,
          child.id,
          parent.id,
          child.name,
          childIndex,
          child.id === DEFAULT_CATEGORY_ID ? 1 : 0,
        );
      });
    });

    seedExtraCategories(db);

    // No manual sqlite_sequence bump is needed: `id INTEGER PRIMARY KEY
    // AUTOINCREMENT` makes SQLite raise the stored sequence to any explicit id
    // we insert, so later locally-created categories start above everything
    // we seeded. Asserted below rather than assumed.
  });

  run();

  const counts = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM currencies) AS currencies,
              (SELECT COUNT(*) FROM categories WHERE parent_id IS NULL) AS parents,
              (SELECT COUNT(*) FROM categories WHERE parent_id IS NOT NULL) AS leaves`,
    )
    .get() as Record<string, number>;

  // A new category must never be handed an id that a future Splitwise import
  // would want. Cheap to verify, expensive to discover later.
  const sequence = db
    .prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'categories'`)
    .get() as { seq: number } | undefined;

  if ((sequence?.seq ?? 0) < MAX_SEEDED_CATEGORY_ID) {
    throw new Error(
      `categories sequence is ${sequence?.seq ?? 0}, expected >= ${MAX_SEEDED_CATEGORY_ID}. ` +
        `New categories could collide with a seeded id.`,
    );
  }

  console.log(`  currencies: ${counts.currencies}`);
  console.log(`  categories: ${counts.parents} parents, ${counts.leaves} leaves (Splitwise + extras)`);

  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`Seeding ${env.DATABASE_PATH}`);
  seed();
}
