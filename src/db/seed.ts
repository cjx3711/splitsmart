/**
 * Seeds reference data: currencies and the category tree.
 *
 * Idempotent — safe to re-run. Uses INSERT OR IGNORE so existing rows (and any
 * splitwise_id values written by the importer) are left alone.
 *
 * NOTE ON CATEGORY IDS: these are OUR ids, not Splitwise's. If you want real
 * Splitwise category-id parity, run the importer against a live
 * `get_categories` response — it fills in `splitwise_id` and remaps.
 * See docs/SPLITWISE_COMPAT.md.
 *
 * Usage:  npm run db:seed
 */
import { openDatabase } from "./index.ts";
import { env } from "../env.ts";
import { CURRENCIES } from "./currencies.ts";

/**
 * Mirrors Splitwise's two-level shape: only leaves are assignable.
 *
 * ⚠️ This tree is a RECONSTRUCTION of Splitwise's categories, not a copy — the
 * names and structure match, but the IDs are ours. For real ID parity, run
 * `npm run seed:splitwise` against an export dump; it rewrites these rows with
 * Splitwise's own ids and fills in splitwise_id. See docs/SPLITWISE_COMPAT.md.
 */
const CATEGORIES: Array<[parent: string, children: string[]]> = [
  ["Entertainment", ["Games", "Movies", "Music", "Sports", "Other"]],
  ["Food and drink", ["Dining out", "Groceries", "Liquor", "Other"]],
  ["Home", [
    "Electronics", "Furniture", "Household supplies", "Maintenance",
    "Mortgage", "Pets", "Rent", "Services", "Other",
  ]],
  ["Life", ["Childcare", "Clothing", "Education", "Gifts", "Insurance", "Medical expenses", "Taxes", "Other"]],
  ["Transportation", ["Bicycle", "Bus/train", "Car", "Gas/fuel", "Hotel", "Parking", "Plane", "Taxi", "Other"]],
  ["Utilities", ["Cleaning", "Electricity", "Heat/gas", "Trash", "TV/Phone/Internet", "Water", "Other"]],
  ["Uncategorized", ["General"]],
];

export function seed(databasePath: string = env.DATABASE_PATH): void {
  const db = openDatabase(databasePath);

  const insertCurrency = db.prepare(
    `INSERT OR IGNORE INTO currencies (code, decimal_places, symbol, name)
     VALUES (?, ?, ?, ?)`,
  );
  const insertParent = db.prepare(
    `INSERT OR IGNORE INTO categories (parent_id, name, sort_order, is_default)
     VALUES (NULL, ?, ?, 0)`,
  );
  const insertChild = db.prepare(
    `INSERT OR IGNORE INTO categories (parent_id, name, sort_order, is_default)
     VALUES (?, ?, ?, ?)`,
  );
  const findCategory = db.prepare(
    `SELECT id FROM categories WHERE name = ? AND parent_id IS ?`,
  );

  const run = db.transaction(() => {
    for (const currency of CURRENCIES) {
      insertCurrency.run(currency.code, currency.decimals, currency.symbol, currency.name);
    }

    CATEGORIES.forEach(([parentName, children], parentIndex) => {
      insertParent.run(parentName, parentIndex);
      const parent = findCategory.get(parentName, null) as { id: number } | undefined;
      if (!parent) throw new Error(`Failed to upsert category ${parentName}`);

      children.forEach((childName, childIndex) => {
        // "Uncategorized > General" is the fallback the compat layer falls back
        // to when an inbound expense has no usable category.
        const isDefault = parentName === "Uncategorized" && childName === "General" ? 1 : 0;
        insertChild.run(parent.id, childName, childIndex, isDefault);
      });
    });
  });

  run();

  const currencyCount = (db.prepare("SELECT COUNT(*) AS n FROM currencies").get() as { n: number }).n;
  const categoryCount = (db.prepare("SELECT COUNT(*) AS n FROM categories").get() as { n: number }).n;
  console.log(`  currencies: ${currencyCount}`);
  console.log(`  categories: ${categoryCount}`);

  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`Seeding ${env.DATABASE_PATH}`);
  seed();
}
