import SQLite from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../env.ts";
import type { Database } from "./types.ts";

/**
 * Opens a SQLite connection with the pragmas this app depends on.
 *
 * foreign_keys is OFF by default in SQLite and must be set per connection -
 * forgetting it means the FK constraints in the schema silently do nothing.
 */
export function openDatabase(path: string = env.DATABASE_PATH): SQLite.Database {
  mkdirSync(dirname(path), { recursive: true });

  const db = new SQLite(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  // Durable enough for a personal app while avoiding an fsync per transaction.
  db.pragma("synchronous = NORMAL");
  return db;
}

export const sqlite = openDatabase();

export const db = new Kysely<Database>({
  dialect: new SqliteDialect({ database: sqlite }),
});

/**
 * Runs `fn` inside a transaction.
 *
 * Every write that touches expenses MUST go through here, because the expense
 * invariant (see migrations/001) spans multiple tables and is only ever true
 * between transactions, not during them.
 */
export async function transaction<T>(
  fn: (trx: Kysely<Database>) => Promise<T>,
): Promise<T> {
  return db.transaction().execute(fn);
}

export type DB = Kysely<Database>;
