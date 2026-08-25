/**
 * Pinned demo-state audit for data/smoke.db.
 *
 * Smoke baselines assume an exact number of scheduler-generated bills. Extra
 * ticks (server reboots, --no-reset captures) drift balances without touching
 * ledger invariants. Run as part of `yarn smoke:check`.
 */
import { db } from "../src/db/index.ts";
import { env } from "../src/env.ts";

const SMOKE_SEED_TODAY = "2026-06-01";
const EXPECTED_RENT_OCCURRENCES = 3;
const EXPECTED_RENT_NEXT_REPEAT = "2026-06-21";
const EXPECTED_GENERATED_BILLS = 6;

function fail(message: string): void {
  console.error(`  FAIL  ${message}`);
}

function ok(message: string): void {
  console.log(`  ok    ${message}`);
}

const dbPath = env.DATABASE_PATH;
if (!dbPath.includes("smoke.db")) {
  console.log(`Skipping smoke seed check for ${dbPath} (not data/smoke.db).`);
  process.exit(0);
}

const apartment = await db
  .selectFrom("groups")
  .select("id")
  .where("name", "=", "Apartment 4B")
  .where("deleted_at", "is", null)
  .executeTakeFirst();

if (!apartment) {
  fail("Apartment 4B group missing — run yarn smoke:reset");
  process.exit(1);
}

const rentRows = await db
  .selectFrom("expenses")
  .select(["id", "repeat_of", "repeat_interval", "next_repeat", "date"])
  .where("group_id", "=", apartment.id)
  .where("description", "=", "Rent")
  .where("deleted_at", "is", null)
  .orderBy("date")
  .execute();

const template = rentRows.find((r) => r.repeat_interval !== null);
const occurrences = rentRows.filter((r) => r.repeat_of !== null);

let failed = false;

if (occurrences.length !== EXPECTED_RENT_OCCURRENCES) {
  fail(
    `Apartment rent occurrences: expected ${EXPECTED_RENT_OCCURRENCES}, got ${occurrences.length}`,
  );
  failed = true;
} else {
  ok(`apartment_rent_occurrences (${EXPECTED_RENT_OCCURRENCES})`);
}

if (!template) {
  fail("Apartment rent template missing");
  failed = true;
} else if (!template.next_repeat?.startsWith(EXPECTED_RENT_NEXT_REPEAT)) {
  fail(
    `Rent template next_repeat: expected ${EXPECTED_RENT_NEXT_REPEAT}, got ${template.next_repeat ?? "null"}`,
  );
  failed = true;
} else {
  ok(`rent_template_next_repeat (${EXPECTED_RENT_NEXT_REPEAT})`);
}

const generated = await db
  .selectFrom("expenses")
  .select("id")
  .where("repeat_of", "is not", null)
  .where("deleted_at", "is", null)
  .execute();

if (generated.length !== EXPECTED_GENERATED_BILLS) {
  fail(`Generated recurring bills: expected ${EXPECTED_GENERATED_BILLS}, got ${generated.length}`);
  failed = true;
} else {
  ok(`generated_recurring_bills (${EXPECTED_GENERATED_BILLS})`);
}

const testUser = await db
  .selectFrom("users")
  .select("id")
  .where("email", "=", "test@example.com")
  .where("deleted_at", "is", null)
  .executeTakeFirst();

if (!testUser) {
  fail("test@example.com missing — run yarn smoke:reset");
  failed = true;
} else {
  // The SEED's net, which is what this file checks. `yarn smoke` runs the
  // flows before it, and F7 writes a 40.00 USD bill into this very group, so
  // without excluding what the flows wrote this check reports drift on every
  // full run and stops meaning anything. Every flow names its writes
  // "Smoke test …" precisely so they can be told apart from seeded rows.
  const shares = await db
    .selectFrom("expense_users as eu")
    .innerJoin("expenses as e", "e.id", "eu.expense_id")
    .select(["eu.paid_share_minor", "eu.owed_share_minor"])
    .where("e.group_id", "=", apartment.id)
    .where("e.deleted_at", "is", null)
    .where("eu.user_id", "=", testUser.id)
    .where("e.description", "not like", "Smoke test%")
    .execute();

  let netMinor = 0;
  for (const row of shares) {
    netMinor += row.paid_share_minor - row.owed_share_minor;
  }

  const expectedMinor = 369_621;
  if (netMinor !== expectedMinor) {
    fail(
      `Apartment 4B net for Test User: expected ${expectedMinor} minor, got ${netMinor}`,
    );
    failed = true;
  } else {
    ok(`apartment_4b_test_user_net (${(expectedMinor / 100).toFixed(2)} USD)`);
  }
}

if (failed) {
  console.error(
    "\nSmoke seed state drifted. Run yarn smoke:reset with the smoke server stopped.",
  );
  console.error(
    "Do not re-record baselines with --no-reset — extra scheduler ticks change balances.",
  );
  process.exit(1);
}

console.log(`Smoke seed state matches SEED_TODAY=${SMOKE_SEED_TODAY} pins.`);
