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

/** decimal_places is the load-bearing field here — see src/domain/money.ts. */
const CURRENCIES: Array<[code: string, decimals: number, symbol: string, name: string]> = [
  ["USD", 2, "$", "US Dollar"],
  ["EUR", 2, "€", "Euro"],
  ["GBP", 2, "£", "British Pound"],
  ["SGD", 2, "S$", "Singapore Dollar"],
  ["AUD", 2, "A$", "Australian Dollar"],
  ["CAD", 2, "C$", "Canadian Dollar"],
  ["NZD", 2, "NZ$", "New Zealand Dollar"],
  ["CHF", 2, "Fr", "Swiss Franc"],
  ["CNY", 2, "¥", "Chinese Yuan"],
  ["HKD", 2, "HK$", "Hong Kong Dollar"],
  ["INR", 2, "₹", "Indian Rupee"],
  ["MYR", 2, "RM", "Malaysian Ringgit"],
  ["THB", 2, "฿", "Thai Baht"],
  ["IDR", 2, "Rp", "Indonesian Rupiah"],
  ["PHP", 2, "₱", "Philippine Peso"],
  ["VND", 0, "₫", "Vietnamese Dong"],
  ["TWD", 2, "NT$", "New Taiwan Dollar"],
  ["KRW", 0, "₩", "South Korean Won"],
  ["JPY", 0, "¥", "Japanese Yen"],
  ["SEK", 2, "kr", "Swedish Krona"],
  ["NOK", 2, "kr", "Norwegian Krone"],
  ["DKK", 2, "kr", "Danish Krone"],
  ["ZAR", 2, "R", "South African Rand"],
  ["BRL", 2, "R$", "Brazilian Real"],
  ["MXN", 2, "$", "Mexican Peso"],
  ["AED", 2, "د.إ", "UAE Dirham"],
  // Three-decimal currencies. These exist specifically to break naive
  // amount * 100 code — keep at least one seeded so tests can catch it.
  ["KWD", 3, "د.ك", "Kuwaiti Dinar"],
  ["BHD", 3, ".د.ب", "Bahraini Dinar"],
  ["OMR", 3, "ر.ع.", "Omani Rial"],
];

/** Mirrors Splitwise's two-level shape: only leaves are assignable. */
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
    for (const [code, decimals, symbol, name] of CURRENCIES) {
      insertCurrency.run(code, decimals, symbol, name);
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
