/**
 * Minimal forward-only migration runner.
 *
 * Applies every `migrations/*.sql` file, in filename order, that isn't already
 * recorded in `schema_migrations`. Each file runs in its own transaction, so a
 * failing migration leaves the database on the last good version rather than
 * half-applied.
 *
 * Note for future schema changes: SQLite cannot ALTER a CHECK constraint, so
 * changing one means rebuilding the table — and if other tables have foreign
 * keys into it you need `PRAGMA foreign_keys=OFF`, which is a NO-OP inside a
 * transaction. Such a migration will need to opt out of the wrapper below and
 * drive its own BEGIN/COMMIT.
 *
 * There is intentionally no `down` migration. Rolling back schema changes
 * against real financial data is more dangerous than fixing forward, and a
 * personal app can afford to restore from backup in the rare case it matters.
 *
 * Usage:  yarn db:migrate
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./index.ts";
import { env } from "../env.ts";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

export function migrate(databasePath: string = env.DATABASE_PATH): number {
  const db = openDatabase(databasePath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    ) STRICT;
  `);

  const applied = new Set(
    db
      .prepare("SELECT name FROM schema_migrations")
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
    });

    try {
      run();
      // Catch a dangling reference here rather than at the next write.
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length > 0) {
        throw new Error(
          `${file} left ${violations.length} foreign key violation(s): ` +
            JSON.stringify(violations.slice(0, 3)),
        );
      }
      console.log(`  applied  ${file}`);
      count++;
    } catch (err) {
      console.error(`  FAILED   ${file}`);
      throw err;
    }
  }

  if (count === 0) console.log("  already up to date");
  db.close();
  return count;
}

// Only run when invoked directly, so tests can import migrate() freely.
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`Migrating ${env.DATABASE_PATH}`);
  migrate();
}
