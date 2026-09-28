import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "splitsmart-migration-"));
process.env.NODE_ENV = "test";
process.env.DATABASE_PATH = join(dir, "module.db");
const { migrate } = await import("./migrate.ts");
const { openDatabase, db } = await import("./index.ts");
const { ulid } = await import("../domain/ulid.ts");

after(async () => { await db.destroy(); rmSync(dir, { recursive: true, force: true }); });

/** The schema already recorded by a pre-upgrade installation, with real rows. */
function oldDatabase(path: string, hasDevelopmentColumn = false) {
  const connection = openDatabase(path);
  connection.exec("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now'))) STRICT");
  for (const name of ["001_initial_schema.sql", "002_email_sends.sql"]) {
    connection.exec(readFileSync(new URL(`../../migrations/${name}`, import.meta.url), "utf8"));
    connection.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(name);
  }
  connection.prepare("INSERT INTO currencies (code) VALUES ('USD')").run();
  const person = ulid(), group = ulid(), expense = ulid();
  connection.prepare("INSERT INTO users (id, name, is_ghost) VALUES (?, 'Owner', 1)").run(person);
  connection.prepare("INSERT INTO groups (id, name, created_by) VALUES (?, 'Existing trip', ?)").run(group, person);
  connection.prepare("INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, 'owner')").run(group, person);
  connection.prepare("INSERT INTO expenses (id, group_id, description, cost_minor, currency_code, date, created_by) VALUES (?, ?, 'Existing dinner', 1234, 'USD', '2026-09-01', ?)").run(expense, group, person);
  if (hasDevelopmentColumn) {
    connection.exec("ALTER TABLE groups ADD COLUMN excluded_from_totals INTEGER NOT NULL DEFAULT 0 CHECK (excluded_from_totals IN (0, 1))");
    connection.prepare("UPDATE groups SET excluded_from_totals = 1").run();
  }
  return connection;
}

test("existing databases gain the group setting without replacing ledger or membership rows", () => {
  const path = join(dir, "upgrade.db");
  const before = oldDatabase(path);
  const expenses = before.prepare("SELECT * FROM expenses").all();
  const members = before.prepare("SELECT * FROM group_members").all();
  const groups = before.prepare("SELECT * FROM groups").all();
  before.close();
  assert.equal(migrate(path), 1);
  const after = openDatabase(path);
  assert.deepEqual(after.prepare("SELECT * FROM expenses").all(), expenses);
  assert.deepEqual(after.prepare("SELECT * FROM group_members").all(), members);
  assert.deepEqual(after.prepare("SELECT * FROM groups").all(), groups.map((g) => ({ ...(g as object), excluded_from_totals: 0 })));
  assert.throws(() => after.exec("UPDATE groups SET excluded_from_totals = 2"), /CHECK/);
  after.prepare("INSERT INTO groups (id, name, excluded_from_totals) VALUES (?, 'New group', 1)").run(ulid());
  assert.deepEqual(after.pragma("foreign_key_check"), []);
  after.close();
  assert.equal(migrate(path), 0);
});

test("development databases with the folded column retain existing settings", () => {
  const path = join(dir, "folded.db");
  oldDatabase(path, true).close();
  assert.equal(migrate(path), 1);
  const connection = openDatabase(path);
  assert.deepEqual(connection.prepare("SELECT excluded_from_totals FROM groups").get(), { excluded_from_totals: 1 });
  assert.ok(connection.prepare("SELECT name FROM schema_migrations WHERE name = '003_group_excluded_totals.sql'").get());
  connection.close();
  assert.equal(migrate(path), 0);
});

test("fresh installations run all migrations and have the same group setting", () => {
  const path = join(dir, "fresh.db");
  assert.equal(migrate(path), 3);
  const connection = openDatabase(path);
  assert.ok((connection.pragma("table_info(groups)") as Array<{ name: string }>).some((c) => c.name === "excluded_from_totals"));
  connection.close();
  assert.equal(migrate(path), 0);
});
