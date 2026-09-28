import { parseAmount } from "../../src/domain/money.ts";
import { computeSplit } from "../../src/domain/split.ts";
import type { ExpenseInput } from "./api.ts";

export const MAX_BULK_ROWS = 500;
export const MAX_CSV_BYTES = 2 * 1024 * 1024;
export const BULK_COLUMNS = ["date", "description", "amount", "currency", "paid_by", "split_with", "group", "category", "notes"];
export interface BulkPerson { id: string; name: string; nickname?: string | null; email?: string | null }
export interface BulkGroup { id: string; name: string; memberIds: string[]; defaultCurrency?: string | null }
export interface BulkCategory { id: number; name: string; path: string }
export interface BulkContext {
  selfId: string;
  people: BulkPerson[];
  groups: BulkGroup[];
  categories: BulkCategory[];
  currencies: Array<{ code: string; decimal_places: number }>;
}
export interface BulkDefaults { currency: string; group: string; payer: string; splitWith: string[] }
export interface BulkRow extends BulkDefaults {
  key: string;
  date: string;
  description: string;
  amount: string;
  category: string;
  notes: string;
}

/** Quoted commas, escaped quotes and multiline fields; malformed records never disappear. */
export function readCsv(text: string): string[][] {
  const input = text.replace(/^\uFEFF/, "").trim();
  if (!input) throw new Error("Choose a CSV file or paste CSV content first.");
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, closed = false;
  const pushField = () => { row.push(field.trim()); field = ""; closed = false; };
  const pushRow = () => {
    pushField();
    if (row.some(Boolean)) rows.push(row);
    row = [];
    if (rows.length > MAX_BULK_ROWS + 1) throw new Error(`Use at most ${MAX_BULK_ROWS} expenses per CSV.`);
  };
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quoted) {
      if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === ",") pushField();
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[i + 1] === "\n") i++;
      pushRow();
    } else if (char === '"') {
      if (field.trim() || closed) throw new Error(`Unexpected quote near record ${rows.length + 1}.`);
      field = ""; quoted = true;
    } else {
      if (closed && char.trim()) throw new Error(`Unexpected text after a quote near record ${rows.length + 1}.`);
      if (!closed) field += char;
    }
  }
  if (quoted) throw new Error("A quoted CSV field is missing its closing quote.");
  pushRow();
  return rows;
}

const normal = (s: string) => s.trim().toLowerCase();
type Choice = { id: string; names: string[] };
function resolve(value: string, choices: Choice[], shortIds = false): string {
  if (choices.some((c) => c.id === value)) return value;
  const matches = choices.filter((c) => c.names.some((name) => normal(name) === normal(value))
    || (shortIds && value.length >= 8 && normal(c.id).endsWith(normal(value))));
  return matches.length === 1 ? matches[0]!.id : value;
}
const personChoices = (context: BulkContext): Choice[] => context.people.map((p) => ({
  id: p.id, names: [p.name, p.nickname ?? "", p.email ?? ""].filter(Boolean),
}));

/** Match against the whole account so a short ID never points to another person. */
function shortId(id: string, choices: Choice[]): string {
  for (let length = 8; length < id.length; length++) {
    const suffix = id.slice(-length);
    if (!choices.some((c) => c.id !== id && (normal(c.id).endsWith(normal(suffix))
      || c.names.some((name) => normal(name) === normal(suffix))))) return suffix;
  }
  return id;
}
export function resolvePerson(value: string, context: BulkContext): string {
  if (["me", "you"].includes(normal(value))) return context.selfId;
  return resolve(value, personChoices(context), true);
}

export function parseBulkCsv(text: string, context: BulkContext, defaults: BulkDefaults): BulkRow[] {
  if (new TextEncoder().encode(text).length > MAX_CSV_BYTES) throw new Error("CSV files must be 2 MB or smaller.");
  const [rawHeader, ...records] = readCsv(text);
  if (!rawHeader) throw new Error("The CSV has no header or expenses.");
  const headers = rawHeader.map(normal);
  for (const required of ["date", "description", "amount"]) {
    if (!headers.includes(required)) throw new Error(`Missing required column: ${required}. Use the CSV format shown below.`);
  }
  if (new Set(headers).size !== headers.length) throw new Error("CSV column names must be unique.");
  const unknown = headers.filter((h) => !BULK_COLUMNS.includes(h));
  if (unknown.length) throw new Error(`Unsupported columns: ${unknown.join(", ")}. Use the CSV format shown below.`);
  if (!records.length) throw new Error("The CSV has a header but no expenses.");
  return records.map((cells, i) => {
    if (cells.length !== headers.length) throw new Error(`Record ${i + 2} has ${cells.length} fields; expected ${headers.length}. Quote fields containing commas.`);
    const get = (name: string) => cells[headers.indexOf(name)] ?? "";
    const group = get("group") ? resolve(get("group"), context.groups.map((g) => ({ id: g.id, names: [g.name] })), true) : defaults.group;
    const splitWith = get("split_with")
      ? get("split_with").split(";").map((v) => resolvePerson(v.trim(), context))
      : group !== defaults.group ? context.groups.find((g) => g.id === group)?.memberIds ?? [] : defaults.splitWith;
    return {
      key: String(i + 2), date: get("date"), description: get("description"), amount: get("amount"),
      currency: (get("currency") || defaults.currency).toUpperCase(), group,
      payer: get("paid_by") ? resolvePerson(get("paid_by"), context) : defaults.payer,
      splitWith: [...new Set(splitWith)],
      category: get("category") ? resolve(get("category"), context.categories.map((c) => ({ id: String(c.id), names: [c.name, c.path, c.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")] }))) : "",
      notes: get("notes"),
    };
  });
}

export function validateBulkRow(row: BulkRow, context: BulkContext): { errors: string[]; input?: ExpenseInput } {
  const errors: string[] = [];
  if (!row.description.trim() || row.description.trim().length > 500) errors.push("Description must contain 1–500 characters.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date) errors.push("Choose a valid date (YYYY-MM-DD).");
  if (row.notes.length > 5000) errors.push("Notes must be 5,000 characters or fewer.");
  const currency = context.currencies.find((c) => c.code === row.currency);
  let costMinor = 0;
  if (!currency) errors.push(`Choose a supported currency (${row.currency || "missing"}).`);
  else {
    try {
      costMinor = parseAmount(row.amount, currency.decimal_places);
      if (costMinor <= 0) errors.push("Amount must be greater than zero.");
    } catch (error) { errors.push(error instanceof Error ? error.message : "Invalid amount."); }
  }
  const group = context.groups.find((g) => g.id === row.group);
  if (row.group && !group) errors.push(`Choose a group or No group (${row.group}).`);
  if (group && !group.memberIds.includes(context.selfId)) errors.push("You must be a current member of this group.");
  const allowed = new Set(group ? group.memberIds : context.people.map((p) => p.id));
  if (!allowed.has(row.payer)) errors.push("Choose a valid payer for this group.");
  if (!row.splitWith.length) errors.push("Choose at least one person to split between.");
  if (row.splitWith.some((id) => !allowed.has(id))) errors.push("Correct the unrecognized people or people outside this group.");
  const ids = [...new Set([row.payer, ...row.splitWith])];
  if (!group && !ids.includes(context.selfId)) errors.push("A non-group expense must include you as payer or participant.");
  if (row.category && !context.categories.some((c) => String(c.id) === row.category)) errors.push("Choose a recognized category or Uncategorized.");
  if (errors.length) return { errors };
  const input: ExpenseInput = {
    groupId: row.group || null, description: row.description.trim(), date: row.date,
    costMinor, currencyCode: row.currency, categoryId: row.category ? Number(row.category) : null,
    details: row.notes.trim(), splitType: "shares",
    participants: ids.map((userId) => ({ userId, paidMinor: userId === row.payer ? costMinor : 0, input: row.splitWith.includes(userId) ? 1 : 0 })),
  };
  // Use the same split engine as individual expenses and the server.
  try { computeSplit(costMinor, "shares", input.participants); }
  catch (error) { return { errors: [error instanceof Error ? error.message : "Invalid split."] }; }
  return { errors: [], input };
}

export function bulkPrompt(context: BulkContext, defaults: BulkDefaults): string {
  const group = context.groups.find((g) => g.id === defaults.group);
  const selected = new Set([context.selfId, defaults.payer, ...defaults.splitWith]);
  const people = context.people.filter((p) => selected.has(p.id) && (!group || group.memberIds.includes(p.id)));
  const choices = personChoices(context);
  const personId = (id: string) => people.some((p) => p.id === id) ? shortId(id, choices) : "REVIEW_REQUIRED";
  const groupId = group ? shortId(group.id, context.groups.map((g) => ({ id: g.id, names: [g.name] }))) : "";
  const currency = context.currencies.find((c) => c.code === defaults.currency);
  return `SplitSmart is an expense-sharing service that tracks who paid, who shares each cost, and who owes whom. Convert my receipts or expense notes into expenses to import into SplitSmart.
Output ONLY CSV with a header; no Markdown fences or explanations.
Columns: ${BULK_COLUMNS.join(",")}
Rules:
- One expense per row. date is YYYY-MM-DD; description is a short label.
- amount is a positive decimal in major currency units, without currency symbols or thousands separators. Never convert currencies or round amounts.
- Default currency: ${defaults.currency}${currency ? ` (${currency.decimal_places} decimal places)` : ""}. Use this unless the source explicitly states another currency; preserve that currency's ISO code and precision.
- paid_by is the short ID of the person who paid the whole expense. Default: ${personId(defaults.payer)}.
- split_with is the semicolon-separated short IDs of the people who OWE a share, split equally. Include the payer only if they share the cost. For “I owe them everything”, paid_by is them and split_with is me. For “they owe me everything”, paid_by is me and split_with is them. My short ID is ${personId(context.selfId)}.
- Default split_with: ${defaults.splitWith.map(personId).join(";") || "REVIEW_REQUIRED (choose people during review)"}.
- ${group ? `Group: ${JSON.stringify(group.name)}. Set group to ${groupId}, or leave blank to use this group.` : "No group selected. Leave group blank."}
- category is a category ID from the list, or blank if uncertain. notes is optional text.
- Do not invent people, dates, currencies, or unequal splits. For uncertain people or unequal splits, put REVIEW_REQUIRED in split_with to block saving until I correct or remove the row. Describe an unequal split in notes so I can handle that expense separately. Leave uncertain dates blank for review.
- Quote fields containing commas, quotes or newlines, and double any quotes inside quoted fields.
- Maximum ${MAX_BULK_ROWS} expenses per file.
People for this import (short ID: name; use only these people):
${people.map((p) => `${personId(p.id)}: ${JSON.stringify(p.nickname || p.name)}`).join("\n")}
Categories (ID: name):
${context.categories.map((c) => `${c.id}: ${JSON.stringify(c.path)}`).join("\n")}

My expense data:
[Paste your receipts, statements, or expense notes here]`;
}
