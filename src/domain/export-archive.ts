/**
 * Full-account export: a ZIP of CSVs covering everything this user can see.
 *
 * `/api/v1/expenses.csv` is the filtered spreadsheet of bills. This is the
 * "download everything" button on Settings: expenses, the comments on them,
 * groups, people, and the profile itself. Money in expenses.csv is a decimal
 * string with the currency in its own column, same as the single-file export,
 * so a spreadsheet that already maps that file maps this one too.
 *
 * Scope is "what the logged-in app shows": expenses the caller is a
 * participant of, plus expenses in groups they currently belong to. It never
 * widens past that — a friend of a friend does not appear.
 */
import type { DB } from "../db/index.ts";
import { collectIdChunks } from "../db/chunk.ts";
import { buildExpenseCsv, csvRow } from "./expense-csv.ts";
import { displayName, knownEmail } from "./person.ts";
import { listRelatedUserIds } from "./friends.ts";
import { zipFiles } from "./zip.ts";

export async function buildExportZip(database: DB, userId: string): Promise<Uint8Array> {
  const [account, expenseIds, groups, people] = await Promise.all([
    loadAccount(database, userId),
    visibleExpenseIds(database, userId),
    loadGroups(database, userId),
    loadPeople(database, userId),
  ]);
  const [expensesCsv, commentsCsv] = await Promise.all([
    buildExpenseCsv(database, expenseIds),
    loadCommentsCsv(database, expenseIds),
  ]);

  const exportedAt = new Date().toISOString().slice(0, 19) + "Z";
  return zipFiles([
    { name: "README.txt", body: readme(exportedAt) },
    { name: "account.csv", body: account },
    { name: "expenses.csv", body: expensesCsv },
    { name: "comments.csv", body: commentsCsv },
    { name: "groups.csv", body: groups },
    { name: "people.csv", body: people },
  ]);
}

function readme(exportedAt: string): string {
  return [
    "SplitSmart data export",
    `Exported at ${exportedAt}`,
    "",
    "account.csv     Your profile (name, email, preferred currency).",
    "expenses.csv    Bills you can see. Same columns as GET /api/v1/expenses.csv:",
    "                money is a decimal string; the currency is its own column.",
    "comments.csv    Comments on those bills, including generated system notes.",
    "groups.csv      Groups you currently belong to, with their members.",
    "people.csv      People you share a group or an expense with.",
    "",
    "This is a snapshot. Nothing in the ledger changes because you downloaded it.",
    "",
  ].join("\n");
}

async function loadAccount(database: DB, userId: string): Promise<string> {
  const user = await database
    .selectFrom("users")
    .select(["name", "nickname", "email", "default_currency"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();

  return [
    csvRow(["name", "nickname", "email", "currency"]),
    csvRow([user.name, user.nickname, user.email, user.default_currency]),
    "",
  ].join("\n");
}

/**
 * Participant of the bill, or currently in its group. Matches what the
 * logged-in app can open, not only the All expenses list (which is
 * participant-only).
 */
async function visibleExpenseIds(database: DB, userId: string): Promise<string[]> {
  const participated = await database
    .selectFrom("expenses")
    .innerJoin("expense_users", "expense_users.expense_id", "expenses.id")
    .select("expenses.id")
    .where("expense_users.user_id", "=", userId)
    .where("expenses.deleted_at", "is", null)
    .execute();

  const inGroups = await database
    .selectFrom("expenses")
    .innerJoin("group_members", "group_members.group_id", "expenses.group_id")
    .select("expenses.id")
    .where("group_members.user_id", "=", userId)
    .where("group_members.left_at", "is", null)
    .where("expenses.deleted_at", "is", null)
    .execute();

  return [...new Set([...participated, ...inGroups].map((row) => row.id))];
}

async function loadCommentsCsv(database: DB, expenseIds: string[]): Promise<string> {
  const header = csvRow(["date", "expense", "author", "kind", "content", "created_at"]);
  if (expenseIds.length === 0) return `${header}\n`;

  const rows = await collectIdChunks(expenseIds, (chunk) =>
    database
      .selectFrom("comments")
      .innerJoin("expenses", "expenses.id", "comments.expense_id")
      .innerJoin("users", "users.id", "comments.user_id")
      .select([
        "expenses.date",
        "expenses.description",
        "users.name",
        "users.nickname",
        "comments.kind",
        "comments.content",
        "comments.created_at",
      ])
      .where("comments.expense_id", "in", chunk)
      .where("comments.deleted_at", "is", null)
      .where("expenses.deleted_at", "is", null)
      .execute(),
  );

  rows.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0));

  const lines = rows.map((row) =>
    csvRow([
      row.date.slice(0, 10),
      row.description,
      displayName(row),
      row.kind,
      row.content,
      row.created_at,
    ]),
  );
  return `${header}\n${lines.join("\n")}\n`;
}

async function loadGroups(database: DB, userId: string): Promise<string> {
  const groups = await database
    .selectFrom("groups")
    .innerJoin("group_members", "group_members.group_id", "groups.id")
    .select([
      "groups.id",
      "groups.name",
      "groups.group_type",
      "groups.default_currency",
      "groups.simplify_by_default",
    ])
    .where("group_members.user_id", "=", userId)
    .where("group_members.left_at", "is", null)
    .where("groups.deleted_at", "is", null)
    .orderBy("groups.name")
    .execute();

  const header = csvRow(["name", "type", "currency", "simplify_debts", "members"]);
  if (groups.length === 0) return `${header}\n`;

  const members = await collectIdChunks(
    groups.map((g) => g.id),
    (chunk) =>
      database
        .selectFrom("group_members")
        .innerJoin("users", "users.id", "group_members.user_id")
        .select(["group_members.group_id", "users.name", "users.nickname"])
        .where("group_members.group_id", "in", chunk)
        .where("group_members.left_at", "is", null)
        .execute(),
  );

  const membersByGroup = new Map<string, string[]>();
  for (const member of members) {
    const list = membersByGroup.get(member.group_id) ?? [];
    list.push(displayName(member));
    membersByGroup.set(member.group_id, list);
  }

  const lines = groups.map((group) =>
    csvRow([
      group.name,
      group.group_type,
      group.default_currency,
      group.simplify_by_default === 1 ? "yes" : "no",
      (membersByGroup.get(group.id) ?? []).sort().join("; "),
    ]),
  );
  return `${header}\n${lines.join("\n")}\n`;
}

async function loadPeople(database: DB, userId: string): Promise<string> {
  const relatedIds = await listRelatedUserIds(database, userId);
  const ids = [...new Set([userId, ...relatedIds])];
  const people = await collectIdChunks(ids, (chunk) =>
    database
      .selectFrom("users")
      .select(["id", "name", "nickname", "email", "invite_email", "is_ghost"])
      .where("id", "in", chunk)
      .where("deleted_at", "is", null)
      .execute(),
  );

  people.sort((a, b) => {
    if (a.id === userId) return -1;
    if (b.id === userId) return 1;
    const an = displayName(a);
    const bn = displayName(b);
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  const header = csvRow(["name", "nickname", "email", "placeholder", "you"]);
  const lines = people.map((person) =>
    csvRow([
      person.name,
      person.nickname,
      knownEmail(person),
      person.is_ghost === 1 ? "yes" : "no",
      person.id === userId ? "yes" : "no",
    ]),
  );
  return `${header}\n${lines.join("\n")}\n`;
}
