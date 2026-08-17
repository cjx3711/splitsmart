/**
 * Native API client.
 *
 * Talks to /api/v1 - the clean internal model, NOT the Splitwise compat layer.
 * Money crosses this boundary as integer minor units, same as the database.
 *
 * When the RPC migration in docs/PLAN.md lands, this file is replaced by Hono's
 * `hc<AppType>()` client and these hand-written types go away.
 *
 * The split types come from the server's own split engine rather than being
 * retyped here. src/domain/split.ts is pure - no database, no Node built-ins -
 * so the browser can import it, and the add-expense form runs the real
 * computeSplit() to preview a split instead of reimplementing its rounding.
 * See web/src/SplitEditor.tsx.
 */
import type { SplitItem, SplitType } from "../../src/domain/split.ts";

export type { SplitItem, SplitType };

export interface ApiUser {
  id: number;
  email: string | null;
  firstName: string;
  lastName: string | null;
  isGhost: boolean;
  defaultCurrency: string;
  emailVerified?: boolean;
  /** False for ghosts, who have no address to confirm. */
  needsEmailVerification?: boolean;
}

export interface Group {
  id: number;
  name: string;
  group_type: string;
  default_currency: string;
  simplify_by_default?: number;
}

export interface CurrencyAmount {
  currencyCode: string;
  amountMinor: number;
}

export interface GroupMember {
  id: number;
  first_name: string;
  last_name: string | null;
  is_ghost: number;
  role: string;
  joined_via: string;
}

/** One person's balance with you, attributed to the group it arose in. */
export interface FriendBreakdown {
  groupId: number | null;
  /** NULL group means one-on-one expenses; the UI supplies the wording. */
  groupName: string | null;
  balances: CurrencyAmount[];
}

export interface Friend {
  id: number;
  email: string | null;
  first_name: string;
  last_name: string | null;
  is_ghost: number;
  /** Only explicit friendships can be removed. */
  is_explicit: boolean | number;
  balances: CurrencyAmount[];
  breakdown: FriendBreakdown[];
}

export interface ExpenseSummary {
  id: number;
  description: string;
  cost_minor: number;
  currency_code: string;
  date: string;
  is_payment: number;
  split_type: string;
  category_name: string | null;
  group_id?: number | null;
  group_name?: string | null;
  shares: Array<{
    user_id: number;
    paid_share_minor: number;
    owed_share_minor: number;
  }>;
}

export interface ExpenseDetail {
  id: number;
  description: string;
  details: string | null;
  cost_minor: number;
  currency_code: string;
  date: string;
  is_payment: number;
  split_type: SplitType;
  split_meta: string | null;
  category_id: number | null;
  category_name: string | null;
  group_id: number | null;
  group_name: string | null;
  shares: Array<{
    user_id: number;
    paid_share_minor: number;
    owed_share_minor: number;
    split_input: number | null;
  }>;
}

export interface ActivityEntry {
  id: number;
  action: string;
  createdAt: string;
  actor: { id: number; firstName: string; lastName: string | null } | null;
  group: { id: number; name: string } | null;
  expense: {
    id: number;
    description: string;
    costMinor: number;
    currencyCode: string;
    deleted: boolean;
  } | null;
}

export interface Currency {
  code: string;
  decimal_places: number;
  symbol: string | null;
  name: string;
}

// --- Splitwise import -------------------------------------------------------

/** How a Splitwise contact was resolved to a local account. */
export interface ImportPerson {
  splitwiseId: number;
  localUserId: number;
  name: string;
  email: string | null;
  matchedBy: "splitwise_id" | "email" | "self" | "created";
  /** Shown once for newly created placeholders; the only way in for them. */
  recoveryCode?: string;
}

export interface ImportFootprint {
  groups: number;
  friends: number;
  expenses: number;
  previouslyImported: number;
}

export interface ImportStatus {
  local: ImportFootprint;
  hasData: boolean;
  previouslyImported: boolean;
  /** Server-owned wording, so the API and the wizard cannot disagree. */
  matchingRule: string;
}

export interface ImportPreview {
  splitwiseAccount: { id: number; name: string; email: string | null };
  counts: { groups: number; friends: number; expenses: number; expensesCapped: boolean };
  people: ImportPerson[];
  groups: Array<{ splitwiseId: number; name: string; members: number; alreadyImported: boolean }>;
  local: ImportFootprint;
  warnings: string[];
}

export interface ImportSkip {
  splitwiseId: number;
  description: string;
  reason: string;
}

export interface ImportExpensePage {
  offset: number;
  fetched: number;
  imported: number;
  alreadyPresent: number;
  skipped: ImportSkip[];
  nextOffset: number | null;
  done: boolean;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    // Session cookie is httpOnly, so it must be sent explicitly.
    credentials: "same-origin",
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // Non-JSON error body; fall back to the status text.
    }
    throw new ApiError(message, res.status);
  }

  return res.json() as Promise<T>;
}

export interface ExpenseInput {
  description: string;
  /** Free-text notes. There is no image upload and there will not be one. */
  details?: string;
  costMinor: number;
  currencyCode: string;
  date: string;
  categoryId?: number | null;
  splitType: SplitType;
  participants: Array<{ userId: number; paidMinor: number; input?: number }>;
  /** Itemized splits only. Rejected by the server for any other split type. */
  items?: SplitItem[];
  /**
   * Itemized only, and only as a caption: the engine spreads whatever the lines
   * do not cover in proportion to what each person ordered whether or not these
   * are sent. The server rejects a pair that disagrees with that gap.
   */
  taxMinor?: number;
  tipMinor?: number;
}

export const api = {
  register: (input: {
    email: string;
    password: string;
    firstName: string;
    lastName?: string;
    defaultCurrency?: string;
  }) => request<{ user: ApiUser }>("/auth/register", { method: "POST", body: JSON.stringify(input) }),

  login: (email: string, password: string) =>
    request<{ user: ApiUser }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  logout: () => request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  /** Unauthenticated - the link is often opened in a different browser. */
  verifyEmail: (token: string) =>
    request<{ ok: boolean; status: string }>(`/auth/verify/${token}`, { method: "POST" }),

  resendVerification: () =>
    request<{ ok: boolean; delivered?: boolean; alreadyVerified?: boolean }>(
      "/auth/verify/resend",
      { method: "POST" },
    ),

  me: () => request<{ user: ApiUser }>("/auth/me"),

  listTokens: () =>
    request<{ tokens: Array<{ id: string; name: string; created_at: string; last_used_at: string | null; revoked_at: string | null }> }>(
      "/auth/tokens",
    ),

  createToken: (name: string) =>
    request<{ id: string; name: string; token: string }>("/auth/tokens", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),

  revokeToken: (id: string) => request<{ ok: boolean }>(`/auth/tokens/${id}`, { method: "DELETE" }),

  listGroups: () =>
    request<{ groups: Group[]; totalBalance: CurrencyAmount[] }>("/groups"),

  createGroup: (input: { name: string; groupType?: string; defaultCurrency?: string }) =>
    request<{ group: Group; inviteUrl: string }>("/groups", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  getGroup: (id: number) =>
    request<{
      group: Group & { inviteUrl: string | null };
      members: GroupMember[];
      balances: Array<{ userId: number; balances: CurrencyAmount[] }>;
    }>(`/groups/${id}`),

  getGroupExpenses: (id: number) =>
    request<{ expenses: ExpenseSummary[] }>(`/groups/${id}/expenses`),

  getSettleSuggestions: (id: number) =>
    request<{
      suggestions: Array<{
        currencyCode: string;
        transfers: Array<{ fromUserId: number; toUserId: number; amountMinor: number }>;
      }>;
    }>(`/groups/${id}/settle`),

  createExpense: (groupId: number, input: ExpenseInput) =>
    request<{ id: number }>(`/groups/${groupId}/expenses`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  createGroupPayment: (
    groupId: number,
    input: {
      fromUserId: number;
      toUserId: number;
      amountMinor: number;
      currencyCode: string;
      date?: string;
    },
  ) =>
    request<{ id: number }>(`/groups/${groupId}/payments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /**
   * The one the add-expense dialog uses: any set of people, group or no group.
   * The group- and friend-scoped creates above stay for the narrower callers.
   */
  createAnyExpense: (input: ExpenseInput & { groupId: number | null }) =>
    request<{ id: number }>("/expenses", { method: "POST", body: JSON.stringify(input) }),

  deleteExpense: (id: number) => request<{ ok: boolean }>(`/expenses/${id}`, { method: "DELETE" }),

  getExpense: (id: number) => request<{ expense: ExpenseDetail }>(`/expenses/${id}`),

  updateExpense: (id: number, input: ExpenseInput & { groupId: number | null }) =>
    request<{ ok: boolean }>(`/expenses/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

  listExpenses: () => request<{ expenses: ExpenseSummary[] }>("/expenses"),

  listActivity: () => request<{ activity: ActivityEntry[] }>("/activity"),

  // --- friends --------------------------------------------------------------

  listFriends: () => request<{ friends: Friend[] }>("/friends"),

  getFriend: (id: number) => request<{ friend: Friend }>(`/friends/${id}`),

  addFriend: (input: { firstName: string; lastName?: string; email?: string }) =>
    request<{
      friend: Friend;
      /** True when the address already belonged to a SplitSmart account. */
      existingAccount: boolean;
      emailDelivered: boolean;
      /** Returned once for a newly created person. Never retrievable again. */
      recoveryCode?: string;
    }>("/friends", { method: "POST", body: JSON.stringify(input) }),

  removeFriend: (id: number) =>
    request<{ ok: boolean; stillVisible: boolean }>(`/friends/${id}`, { method: "DELETE" }),

  getFriendExpenses: (id: number) =>
    request<{ expenses: ExpenseSummary[] }>(`/friends/${id}/expenses`),

  createFriendExpense: (friendId: number, input: ExpenseInput) =>
    request<{ id: number }>(`/friends/${friendId}/expenses`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  createFriendPayment: (
    friendId: number,
    input: {
      direction: "you_paid" | "they_paid";
      amountMinor: number;
      currencyCode: string;
      date?: string;
    },
  ) =>
    request<{ id: number }>(`/friends/${friendId}/payments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  // --- Splitwise import -----------------------------------------------------
  //
  // The API key is passed on every call and never stored, server-side or here.
  // Keep it in component state only - never localStorage.

  importStatus: () => request<ImportStatus>("/import/status"),

  importPreview: (apiKey: string) =>
    request<ImportPreview>("/import/preview", { method: "POST", body: JSON.stringify({ apiKey }) }),

  importFriends: (apiKey: string) =>
    request<{ people: ImportPerson[]; created: number; matched: number }>("/import/friends", {
      method: "POST",
      body: JSON.stringify({ apiKey }),
    }),

  importGroups: (apiKey: string) =>
    request<{
      groups: Array<{ splitwiseId: number; localGroupId: number; name: string; created: boolean }>;
      people: ImportPerson[];
      created: number;
      matched: number;
    }>("/import/groups", { method: "POST", body: JSON.stringify({ apiKey }) }),

  /** One page. Feed `nextOffset` back in until `done`. */
  importExpenses: (apiKey: string, offset = 0) =>
    request<ImportExpensePage>("/import/expenses", {
      method: "POST",
      body: JSON.stringify({ apiKey, offset }),
    }),

  // --- reference data -------------------------------------------------------

  listCategories: () =>
    request<{ categories: Array<{ id: number; parent_id: number | null; name: string }> }>(
      "/categories",
    ),

  listCurrencies: () => request<{ currencies: Currency[] }>("/categories/currencies"),

  /** Currencies the caller has actually used, most-used first. */
  frequentCurrencies: () => request<{ codes: string[] }>("/expenses/currencies/frequent"),

  previewInvite: (token: string) =>
    request<{ group: { name: string; type: string; memberCount: number; memberNames: string[] } }>(
      `/invite/${token}/preview`,
    ),

  joinInvite: (token: string, displayName: string) =>
    request<{
      user: { id: number; firstName: string; isGhost: boolean };
      group: { id: number; name: string };
      recoveryCode: string;
    }>(`/invite/${token}/join`, { method: "POST", body: JSON.stringify({ displayName }) }),

  recover: (recoveryCode: string) =>
    request<{ user: { id: number; firstName: string } }>("/invite/recover", {
      method: "POST",
      body: JSON.stringify({ recoveryCode }),
    }),

  claim: (email: string, password: string) =>
    request<{ ok: boolean; verificationEmailSent: boolean }>("/invite/claim", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
};

// --- money formatting -------------------------------------------------------

/**
 * Minor units -> display string. Mirrors src/domain/money.ts formatAmount.
 *
 * `decimalPlaces` is required rather than defaulting to 2, because defaulting
 * is how JPY ends up displayed as one hundredth of its real value. Callers get
 * it from the currencies table via useCurrencies() - never from a guess.
 */
export function formatMoney(minor: number, decimalPlaces: number): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const body =
    decimalPlaces === 0
      ? String(abs)
      : (() => {
          const divisor = 10 ** decimalPlaces;
          const whole = Math.floor(abs / divisor);
          const fraction = String(abs % divisor).padStart(decimalPlaces, "0");
          return `${whole}.${fraction}`;
        })();
  return `${negative ? "-" : ""}${body}`;
}

/** Display string -> minor units. Throws on excess precision, like the server. */
export function parseMoney(input: string, decimalPlaces: number): number {
  const raw = input.trim();
  if (!/^-?\d*(\.\d*)?$/.test(raw) || raw === "" || raw === ".") {
    throw new Error(`Not a valid amount: ${input}`);
  }
  const negative = raw.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? raw.slice(1) : raw).split(".");
  if (fraction.length > decimalPlaces) {
    throw new Error("Too many decimal places for this currency");
  }
  const minor =
    Number(whole) * 10 ** decimalPlaces + Number(fraction.padEnd(decimalPlaces, "0") || "0");
  return negative ? -minor : minor;
}

export function fullName(person: {
  first_name: string;
  last_name: string | null;
}): string {
  return [person.first_name, person.last_name].filter(Boolean).join(" ");
}
