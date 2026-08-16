/**
 * Manually mark a user's email as verified.
 *
 * THE LOCKOUT ESCAPE HATCH. If EMAIL_VERIFICATION_REQUIRED=true and Postmark is
 * misconfigured, down, or the mail is landing in spam, nobody can log in and
 * there is no in-app way out. This script is that way out — it needs only
 * filesystem access to the database, which you have on a self-hosted box.
 *
 * Usage:
 *   yarn verify:user -- alice@example.com
 *   yarn verify:user -- --list          # show unverified accounts
 */
import { openDatabase } from "../src/db/index.ts";
import { env } from "../src/env.ts";

function main(): void {
  const arg = process.argv[2];

  if (!arg) {
    console.error("Usage: yarn verify:user -- <email>");
    console.error("       yarn verify:user -- --list");
    process.exit(1);
  }

  const db = openDatabase(env.DATABASE_PATH);

  if (arg === "--list") {
    const rows = db
      .prepare(
        `SELECT id, email, first_name, created_at
         FROM users
         WHERE is_ghost = 0 AND email_verified_at IS NULL AND deleted_at IS NULL
         ORDER BY created_at`,
      )
      .all() as Array<{ id: number; email: string; first_name: string; created_at: string }>;

    if (rows.length === 0) {
      console.log("No unverified accounts.");
    } else {
      console.log(`${rows.length} unverified account(s):\n`);
      for (const row of rows) {
        console.log(`  ${row.id}\t${row.email}\t${row.first_name}\t(created ${row.created_at})`);
      }
    }
    db.close();
    return;
  }

  const user = db
    .prepare(
      `SELECT id, email, first_name, email_verified_at, is_ghost
       FROM users WHERE email = ? AND deleted_at IS NULL`,
    )
    .get(arg) as
    | { id: number; email: string; first_name: string; email_verified_at: string | null; is_ghost: number }
    | undefined;

  if (!user) {
    console.error(`No account with email ${arg}`);
    db.close();
    process.exit(1);
  }

  if (user.is_ghost === 1) {
    console.error(`${arg} is a guest account and has no email to verify.`);
    db.close();
    process.exit(1);
  }

  if (user.email_verified_at) {
    console.log(`${arg} is already verified (${user.email_verified_at}).`);
    db.close();
    return;
  }

  const now = new Date().toISOString();
  const run = db.transaction(() => {
    db.prepare("UPDATE users SET email_verified_at = ? WHERE id = ?").run(now, user.id);
    // Retire outstanding links — the address is confirmed, so they are dead weight.
    db.prepare(
      `UPDATE email_tokens SET used_at = ?
       WHERE user_id = ? AND purpose = 'verify_email' AND used_at IS NULL`,
    ).run(now, user.id);
  });
  run();

  console.log(`Verified ${user.email} (user ${user.id}).`);
  db.close();
}

main();
