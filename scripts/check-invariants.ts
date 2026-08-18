/**
 * Data integrity audit.
 *
 * SQLite cannot express the constraints this data model depends on; they span
 * rows and tables, so they are enforced in application code and verified here.
 * Run after imports, after schema changes, and any time balances look wrong:
 *
 *   yarn db:check
 *
 * Exits non-zero if anything fails, so it can gate a deploy or run from cron.
 */
import { openDatabase } from "../src/db/index.ts";
import { env } from "../src/env.ts";

interface Check {
  name: string;
  description: string;
  sql: string;
}

const CHECKS: Check[] = [
  {
    name: "paid_shares_sum_to_cost",
    description: "Each expense's paid shares must add up to its total",
    sql: `
      SELECT e.id, e.description, e.cost_minor,
             COALESCE(SUM(eu.paid_share_minor), 0) AS actual
      FROM expenses e
      LEFT JOIN expense_users eu ON eu.expense_id = e.id
      WHERE e.deleted_at IS NULL
      GROUP BY e.id
      HAVING actual <> e.cost_minor
    `,
  },
  {
    name: "owed_shares_sum_to_cost",
    description: "Each expense's owed shares must add up to its total",
    sql: `
      SELECT e.id, e.description, e.cost_minor,
             COALESCE(SUM(eu.owed_share_minor), 0) AS actual
      FROM expenses e
      LEFT JOIN expense_users eu ON eu.expense_id = e.id
      WHERE e.deleted_at IS NULL
      GROUP BY e.id
      HAVING actual <> e.cost_minor
    `,
  },
  {
    name: "repayments_match_net_positions",
    description:
      "expense_repayments must be a faithful derivation of expense_users (it is a cache)",
    sql: `
      WITH net AS (
        SELECT eu.expense_id, eu.user_id,
               eu.paid_share_minor - eu.owed_share_minor AS net_minor
        FROM expense_users eu
        JOIN expenses e ON e.id = eu.expense_id
        WHERE e.deleted_at IS NULL
      ),
      derived AS (
        SELECT expense_id, user_id, SUM(amount) AS amount FROM (
          SELECT expense_id, to_user_id   AS user_id,  amount_minor AS amount
          FROM expense_repayments
          UNION ALL
          SELECT expense_id, from_user_id AS user_id, -amount_minor AS amount
          FROM expense_repayments
        ) GROUP BY expense_id, user_id
      )
      SELECT n.expense_id, n.user_id, n.net_minor,
             COALESCE(d.amount, 0) AS derived_minor
      FROM net n
      LEFT JOIN derived d ON d.expense_id = n.expense_id AND d.user_id = n.user_id
      WHERE n.net_minor <> COALESCE(d.amount, 0)
    `,
  },
  {
    name: "repayments_net_to_zero",
    description: "Every expense's repayments must net to zero overall",
    sql: `
      SELECT expense_id, SUM(amount_minor) AS total
      FROM expense_repayments
      GROUP BY expense_id
      HAVING SUM(amount_minor) <> (
        SELECT SUM(amount_minor) FROM expense_repayments r2
        WHERE r2.expense_id = expense_repayments.expense_id
      )
    `,
  },
  {
    name: "group_balances_net_to_zero",
    description: "Within a group and currency, all balances must cancel out",
    sql: `
      SELECT e.group_id, e.currency_code, SUM(x.amount) AS total FROM (
        SELECT r.expense_id, r.to_user_id AS user_id,  r.amount_minor AS amount
        FROM expense_repayments r
        UNION ALL
        SELECT r.expense_id, r.from_user_id AS user_id, -r.amount_minor AS amount
        FROM expense_repayments r
      ) x
      JOIN expenses e ON e.id = x.expense_id
      WHERE e.deleted_at IS NULL AND e.group_id IS NOT NULL
      GROUP BY e.group_id, e.currency_code
      HAVING SUM(x.amount) <> 0
    `,
  },
  {
    name: "no_orphan_expense_users",
    description: "expense_users rows must reference a live expense",
    sql: `
      SELECT eu.expense_id, eu.user_id
      FROM expense_users eu
      LEFT JOIN expenses e ON e.id = eu.expense_id
      WHERE e.id IS NULL
    `,
  },
  {
    name: "expenses_have_participants",
    description: "Every live expense must have at least one participant",
    sql: `
      SELECT e.id, e.description
      FROM expenses e
      LEFT JOIN expense_users eu ON eu.expense_id = e.id
      WHERE e.deleted_at IS NULL AND eu.expense_id IS NULL
    `,
  },
  {
    name: "real_users_can_authenticate",
    description: "Non-ghost users must have both an email and a password hash",
    sql: `
      SELECT id, name FROM users
      WHERE is_ghost = 0 AND (email IS NULL OR password_hash IS NULL)
    `,
  },
  {
    name: "ghosts_have_no_password",
    description: "Ghost accounts must not carry credentials they cannot use",
    sql: `SELECT id, name FROM users WHERE is_ghost = 1 AND password_hash IS NOT NULL`,
  },
  {
    name: "ghosts_have_no_login_email",
    description:
      "Ghosts must not occupy users.email: that unique index is for real accounts, and squatting it blocks sign-up",
    sql: `SELECT id, name FROM users WHERE is_ghost = 1 AND email IS NOT NULL`,
  },
  {
    name: "invite_email_is_ghosts_only",
    description: "invite_email is the address a ghost was invited at; real accounts do not have one",
    sql: `SELECT id, name FROM users WHERE is_ghost = 0 AND invite_email IS NOT NULL`,
  },
  {
    name: "invite_email_unique_per_owner",
    description:
      "One owner must not have two live friend-ghosts invited at the same address",
    sql: `
      SELECT owner.id AS owner_id, ghost.invite_email, COUNT(*) AS n
      FROM friendships f
      JOIN users owner ON owner.is_ghost = 0 AND (
        owner.id = f.user_a_id OR owner.id = f.user_b_id
      )
      JOIN users ghost ON ghost.is_ghost = 1
        AND ghost.deleted_at IS NULL
        AND ghost.invite_email IS NOT NULL
        AND ghost.id = CASE
          WHEN f.user_a_id = owner.id THEN f.user_b_id
          ELSE f.user_a_id
        END
      GROUP BY owner.id, ghost.invite_email
      HAVING COUNT(*) > 1
    `,
  },
  {
    name: "merged_users_are_retired",
    description:
      "A user consumed by a claim must be soft-deleted, not left walking around",
    sql: `
      SELECT id, name FROM users
      WHERE merged_into_user_id IS NOT NULL AND deleted_at IS NULL
    `,
  },
  {
    name: "nothing_points_at_a_merged_user",
    description:
      "A merge rewrites every FK onto the survivor; a leftover pointer is money attached to a stub",
    sql: `
      WITH stub AS (SELECT id FROM users WHERE merged_into_user_id IS NOT NULL)
      SELECT 'expense_users' AS source, eu.user_id AS user_id
      FROM expense_users eu JOIN stub ON stub.id = eu.user_id
      UNION ALL
      SELECT 'expense_repayments', r.from_user_id
      FROM expense_repayments r JOIN stub ON stub.id = r.from_user_id
      UNION ALL
      SELECT 'expense_repayments', r.to_user_id
      FROM expense_repayments r JOIN stub ON stub.id = r.to_user_id
      UNION ALL
      SELECT 'group_members', gm.user_id
      FROM group_members gm JOIN stub ON stub.id = gm.user_id
      UNION ALL
      SELECT 'friendships', f.user_a_id
      FROM friendships f JOIN stub ON stub.id = f.user_a_id
      UNION ALL
      SELECT 'friendships', f.user_b_id
      FROM friendships f JOIN stub ON stub.id = f.user_b_id
      UNION ALL
      SELECT 'comments', c.user_id
      FROM comments c JOIN stub ON stub.id = c.user_id
    `,
  },
  {
    name: "live_links_act_as_live_ghosts",
    description:
      "An access link may only act as a person who is still an unclaimed ghost",
    sql: `
      SELECT al.id, al.kind, al.user_id
      FROM access_links al
      JOIN users u ON u.id = al.user_id
      WHERE al.revoked_at IS NULL
        AND (u.is_ghost = 0 OR u.deleted_at IS NOT NULL)
    `,
  },
  {
    name: "known_comment_kinds",
    description: "A comment is either something somebody typed or a generated system note",
    sql: `SELECT id, kind FROM comments WHERE kind NOT IN ('user', 'system')`,
  },
  {
    name: "repeat_series_are_one_level_deep",
    description:
      "An occurrence must point at a template, never at another occurrence: the template id plus repeat_of IS the bundle",
    sql: `
      SELECT child.id, child.repeat_of
      FROM expenses child
      JOIN expenses parent ON parent.id = child.repeat_of
      WHERE child.repeat_of IS NOT NULL AND parent.repeat_of IS NOT NULL
    `,
  },
  {
    name: "recurring_templates_are_scheduled",
    description:
      "A live template must have a next_repeat, or it is a series that silently never runs",
    sql: `
      SELECT id, description FROM expenses
      WHERE repeat_interval IS NOT NULL AND next_repeat IS NULL AND deleted_at IS NULL
    `,
  },
  {
    name: "no_duplicate_occurrences",
    description:
      "One occurrence per template per due date; two means the scheduler generated a bill twice",
    sql: `
      SELECT repeat_of, date, COUNT(*) AS n
      FROM expenses
      WHERE repeat_of IS NOT NULL AND deleted_at IS NULL
      GROUP BY repeat_of, date
      HAVING COUNT(*) > 1
    `,
  },
  {
    name: "known_currencies_only",
    description: "Every expense currency must exist in the currencies table",
    sql: `
      SELECT DISTINCT e.currency_code
      FROM expenses e
      LEFT JOIN currencies c ON c.code = e.currency_code
      WHERE c.code IS NULL
    `,
  },
];

function main(): void {
  const db = openDatabase(env.DATABASE_PATH);
  console.log(`Checking ${env.DATABASE_PATH}\n`);

  let failures = 0;

  for (const check of CHECKS) {
    let rows: unknown[];
    try {
      rows = db.prepare(check.sql).all();
    } catch (err) {
      console.log(`  ERROR  ${check.name}`);
      console.log(`         query failed: ${err instanceof Error ? err.message : String(err)}`);
      failures++;
      continue;
    }

    if (rows.length === 0) {
      console.log(`  ok     ${check.name}`);
    } else {
      failures++;
      console.log(`  FAIL   ${check.name}`);
      console.log(`         ${check.description}`);
      console.log(`         ${rows.length} offending row(s):`);
      for (const row of rows.slice(0, 5)) {
        console.log(`           ${JSON.stringify(row)}`);
      }
      if (rows.length > 5) console.log(`           ... and ${rows.length - 5} more`);
    }
  }

  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users)    AS users,
         (SELECT COUNT(*) FROM groups)   AS groups,
         (SELECT COUNT(*) FROM expenses WHERE deleted_at IS NULL) AS expenses,
         (SELECT COUNT(*) FROM expenses WHERE deleted_at IS NOT NULL) AS deleted,
         (SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL) AS comments,
         (SELECT COUNT(*) FROM expenses
           WHERE repeat_interval IS NOT NULL AND deleted_at IS NULL) AS series`,
    )
    .get() as Record<string, number>;

  console.log(
    `\n${counts.users} users, ${counts.groups} groups, ${counts.expenses} live expenses ` +
      `(${counts.deleted} deleted and restorable), ${counts.comments} comments, ` +
      `${counts.series} recurring series`,
  );

  db.close();

  if (failures > 0) {
    console.error(`\n${failures} check(s) FAILED.`);
    process.exit(1);
  }
  console.log("All checks passed.");
}

main();
