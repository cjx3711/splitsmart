/**
 * Splitwise wire-format serializers.
 *
 * THIS IS A TRANSLATION BOUNDARY. Splitwise's v3.0 API has conventions we do
 * not want anywhere else in the codebase:
 *
 *   - money as decimal STRINGS ("25.00"), not integers
 *   - `users__0__paid_share` flattened form keys instead of nested arrays
 *   - `deleted_at` tombstones rather than filtered queries
 *   - per-currency `balance` arrays
 *
 * Everything ugly about that shape lives in this file and its route module.
 * The rest of the app speaks the native model (integer minor units, nested
 * objects). If you find yourself formatting a decimal string outside
 * src/routes/compat/, something has leaked.
 *
 * Verified against real Splitwise responses. See docs/SPLITWISE_COMPAT.md for
 * the captured fixtures and the exact field list splitwise-to-toshl consumes.
 */
import { formatAmount } from "../../domain/money.ts";
import type { CurrencyAmount } from "../../domain/balances.ts";

export interface SerializableUser {
  id: number;
  first_name: string;
  last_name: string | null;
  email: string | null;
  avatar_url: string | null;
  default_currency: string;
  is_ghost: number;
}

/** Currency code -> decimal places, loaded once per request from `currencies`. */
export type DecimalPlacesLookup = (currencyCode: string) => number;

/**
 * Ghost accounts have no email, but splitwise-to-toshl treats a falsy
 * `user.email` as an invalid account and refuses to start. Synthesising a
 * non-routable address keeps those clients working. `.invalid` is reserved by
 * RFC 2606 precisely so it can never resolve to a real mailbox.
 */
export function emailFor(user: { id: number; email: string | null }): string {
  return user.email ?? `ghost-${user.id}@splitsmart.invalid`;
}

export function serializeUser(user: SerializableUser) {
  return {
    id: user.id,
    first_name: user.first_name,
    last_name: user.last_name,
    email: emailFor(user),
    registration_status: user.is_ghost === 1 ? "dummy" : "confirmed",
    picture: {
      small: user.avatar_url,
      medium: user.avatar_url,
      large: user.avatar_url,
    },
    custom_picture: user.avatar_url !== null,
  };
}

export function serializeCurrentUser(
  user: SerializableUser & { created_at?: string },
) {
  return {
    ...serializeUser(user),
    default_currency: user.default_currency,
    locale: "en",
    date_format: "MM/DD/YYYY",
    default_group_id: -1,
    notifications_read: null,
    notifications_count: 0,
  };
}

/**
 * Splitwise returns balances as an array with one entry per currency, and omits
 * currencies that net to zero. Preserving both behaviours matters: clients index
 * into `balance[0]` and treat an empty array as "settled up".
 */
export function serializeBalance(
  balances: CurrencyAmount[],
  decimals: DecimalPlacesLookup,
) {
  return balances
    .filter((b) => b.amountMinor !== 0)
    .map((b) => ({
      currency_code: b.currencyCode,
      amount: formatAmount(b.amountMinor, decimals(b.currencyCode)),
    }));
}

export function serializeFriend(
  user: SerializableUser,
  balances: CurrencyAmount[],
  decimals: DecimalPlacesLookup,
) {
  return {
    ...serializeUser(user),
    balance: serializeBalance(balances, decimals),
    groups: [] as unknown[],
    updated_at: null,
  };
}

export interface SerializableExpense {
  id: number;
  group_id: number | null;
  description: string;
  details: string | null;
  cost_minor: number;
  currency_code: string;
  date: string;
  category_id: number | null;
  category_name: string | null;
  is_payment: number;
  created_by: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SerializableExpenseUser {
  user_id: number;
  paid_share_minor: number;
  owed_share_minor: number;
  user: SerializableUser;
}

export interface SerializableRepayment {
  from_user_id: number;
  to_user_id: number;
  amount_minor: number;
}

export function serializeExpense(
  expense: SerializableExpense,
  users: SerializableExpenseUser[],
  repayments: SerializableRepayment[],
  decimals: DecimalPlacesLookup,
) {
  const dp = decimals(expense.currency_code);
  const money = (minor: number) => formatAmount(minor, dp);

  return {
    id: expense.id,
    group_id: expense.group_id,
    description: expense.description,
    details: expense.details,
    payment: expense.is_payment === 1,
    cost: money(expense.cost_minor),
    currency_code: expense.currency_code,
    // Clients split on "T", so a bare date would break them.
    date: toIsoZ(expense.date),
    // Nested object, not a flat name; Friend.tsx reads `e.category.name`.
    category: {
      id: expense.category_id,
      name: expense.category_name ?? "General",
    },
    created_at: toIsoZ(expense.created_at),
    updated_at: toIsoZ(expense.updated_at),
    deleted_at: expense.deleted_at ? toIsoZ(expense.deleted_at) : null,
    created_by: users.find((u) => u.user_id === expense.created_by)
      ? serializeUser(users.find((u) => u.user_id === expense.created_by)!.user)
      : null,
    repayments: repayments.map((r) => ({
      from: r.from_user_id,
      to: r.to_user_id,
      amount: money(r.amount_minor),
    })),
    users: users.map((u) => ({
      user: serializeUser(u.user),
      // Both `user_id` and `user.id` are present in real responses and clients
      // use them interchangeably; Friend.tsx reads both on the same object.
      user_id: u.user_id,
      paid_share: money(u.paid_share_minor),
      owed_share: money(u.owed_share_minor),
      net_balance: money(u.paid_share_minor - u.owed_share_minor),
    })),
    // Fields we do not model yet, present so clients never see `undefined`.
    receipt: { large: null, original: null },
    comments_count: 0,
    expense_bundle_id: null,
    repeats: false,
    repeat_interval: null,
    email_reminder: false,
    email_reminder_in_advance: -1,
    next_repeat: null,
    friendship_id: null,
    creation_method: "equal",
    transaction_method: "offline",
    transaction_confirmed: false,
  };
}

export interface SerializableCategory {
  id: number;
  name: string;
  icon: string | null;
  children: Array<{ id: number; name: string; icon: string | null }>;
}

export function serializeCategory(category: SerializableCategory) {
  return {
    id: category.id,
    name: category.name,
    icon: category.icon,
    icon_types: { slim: { small: null, large: null }, square: { large: null, xxlarge: null } },
    subcategories: category.children.map((child) => ({
      id: child.id,
      name: child.name,
      icon: child.icon,
      icon_types: { slim: { small: null, large: null }, square: { large: null, xxlarge: null } },
    })),
  };
}

/**
 * Parses Splitwise's flattened participant keys back into an array.
 *
 *   { users__0__user_id: 5, users__0__paid_share: "20.00", ... }
 *     -> [{ user_id: 5, paid_share: "20.00", ... }]
 *
 * Indices need not be contiguous or ordered; real clients emit gaps.
 */
export function parseFlattenedUsers(
  body: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const byIndex = new Map<number, Record<string, unknown>>();

  for (const [key, value] of Object.entries(body)) {
    const match = /^users__(\d+)__(.+)$/.exec(key);
    if (!match) continue;

    const index = Number(match[1]);
    const field = match[2]!;
    const entry = byIndex.get(index) ?? {};
    entry[field] = value;
    byIndex.set(index, entry);
  }

  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, entry]) => entry);
}

/**
 * Splitwise emits "2026-08-17T00:00:00Z". SQLite's datetime() gives
 * "2026-08-17 00:00:00". Normalise so clients can rely on the format.
 */
function toIsoZ(value: string): string {
  if (value.includes("T")) {
    return value.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
  }
  return `${value.replace(" ", "T")}Z`;
}
