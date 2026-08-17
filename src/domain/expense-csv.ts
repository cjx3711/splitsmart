/**
 * CSV export of expenses.
 *
 * One row per expense, not one per participant: a spreadsheet of bills is what
 * people ask for, and a per-participant shape turns "12 dinners" into 40 rows
 * that all have to be re-collapsed before they can be read. Who paid and who
 * owed travel as two `Name: amount` lists, so nothing is lost.
 *
 * MONEY IS A DECIMAL STRING HERE, formatted with the currency's own decimal
 * places via `formatAmount`. That is the one place in the app outside the compat
 * layer where a decimal string is correct: a CSV is read by humans and
 * spreadsheets, neither of which knows what a minor unit is. The currency travels
 * in its own column so the number is never ambiguous.
 */
import type { DB } from "../db/index.ts";
import { formatAmount } from "./money.ts";

/** Header row, in order. Changing this changes anybody's saved import mapping. */
export const CSV_COLUMNS = [
  "date",
  "description",
  "category",
  "group",
  "currency",
  "cost",
  "is_payment",
  "paid_by",
  "owed_by",
  "notes",
  "comments",
  "repeats",
] as const;

/**
 * RFC 4180 quoting: wrap anything containing a comma, quote or newline, and
 * double the quotes inside.
 *
 * Values are NOT otherwise mangled. Some exporters prefix a leading `=` or `-`
 * to stop a spreadsheet treating a description as a formula; that also turns
 * "-5 for the tip" into nonsense, and this is the caller's own data coming back
 * to them, so honesty wins.
 */
export function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: Array<string | number | null | undefined>): string {
  return values.map(csvField).join(",");
}

/**
 * Builds the whole document for a set of expense ids.
 *
 * The ids come from the caller, which is what keeps this honest about
 * visibility: the native route passes the caller's own filtered list and the
 * guest route passes only what the link can see. This function never widens a
 * scope, because it never works one out.
 */
export async function buildExpenseCsv(database: DB, expenseIds: string[]): Promise<string> {
  const header = csvRow([...CSV_COLUMNS]);
  if (expenseIds.length === 0) return `${header}\n`;

  const expenses = await database
    .selectFrom("expenses")
    .leftJoin("categories", "categories.id", "expenses.category_id")
    .leftJoin("groups", "groups.id", "expenses.group_id")
    .select([
      "expenses.id",
      "expenses.description",
      "expenses.details",
      "expenses.cost_minor",
      "expenses.currency_code",
      "expenses.date",
      "expenses.is_payment",
      "expenses.repeat_interval",
      "expenses.repeat_of",
      "categories.name as category_name",
      "groups.name as group_name",
    ])
    .where("expenses.id", "in", expenseIds)
    .where("expenses.deleted_at", "is", null)
    .orderBy("expenses.date", "desc")
    .orderBy("expenses.id", "desc")
    .execute();

  if (expenses.length === 0) return `${header}\n`;

  const ids = expenses.map((e) => e.id);

  const [shares, currencies, comments] = await Promise.all([
    database
      .selectFrom("expense_users")
      .innerJoin("users", "users.id", "expense_users.user_id")
      .select([
        "expense_users.expense_id",
        "expense_users.paid_share_minor",
        "expense_users.owed_share_minor",
        "users.first_name",
        "users.last_name",
      ])
      .where("expense_users.expense_id", "in", ids)
      .execute(),
    database.selectFrom("currencies").select(["code", "decimal_places"]).execute(),
    database
      .selectFrom("comments")
      .select(["expense_id"])
      .where("expense_id", "in", ids)
      .where("deleted_at", "is", null)
      .execute(),
  ]);

  const decimalsByCode = new Map(currencies.map((c) => [c.code, c.decimal_places]));
  const sharesByExpense = new Map<string, typeof shares>();
  for (const share of shares) {
    const list = sharesByExpense.get(share.expense_id) ?? [];
    list.push(share);
    sharesByExpense.set(share.expense_id, list);
  }

  const commentCounts = new Map<string, number>();
  for (const comment of comments) {
    commentCounts.set(comment.expense_id, (commentCounts.get(comment.expense_id) ?? 0) + 1);
  }

  const lines = expenses.map((expense) => {
    // A currency that is not in the table cannot happen (foreign key), but
    // defaulting to 2 keeps a broken seed from throwing mid-download.
    const decimals = decimalsByCode.get(expense.currency_code) ?? 2;
    const money = (minor: number) => formatAmount(minor, decimals);
    const people = (sharesByExpense.get(expense.id) ?? []).slice().sort((a, b) => {
      const left = fullName(a);
      const right = fullName(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });

    return csvRow([
      expense.date.slice(0, 10),
      expense.description,
      expense.category_name,
      expense.group_name,
      expense.currency_code,
      money(expense.cost_minor),
      expense.is_payment === 1 ? "yes" : "no",
      people
        .filter((p) => p.paid_share_minor > 0)
        .map((p) => `${fullName(p)}: ${money(p.paid_share_minor)}`)
        .join("; "),
      people
        .filter((p) => p.owed_share_minor > 0)
        .map((p) => `${fullName(p)}: ${money(p.owed_share_minor)}`)
        .join("; "),
      expense.details,
      commentCounts.get(expense.id) ?? 0,
      expense.repeat_interval ?? (expense.repeat_of ? "occurrence" : ""),
    ]);
  });

  return `${header}\n${lines.join("\n")}\n`;
}

function fullName(person: { first_name: string; last_name: string | null }): string {
  return [person.first_name, person.last_name].filter(Boolean).join(" ");
}
