/**
 * Native API client.
 *
 * Talks to /api/v1 — the clean internal model, NOT the Splitwise compat layer.
 * Money crosses this boundary as integer minor units, same as the database.
 *
 * When the RPC migration in docs/PLAN.md lands, this file is replaced by Hono's
 * `hc<AppType>()` client and these hand-written types go away.
 */

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
  costMinor: number;
  currencyCode: string;
  date: string;
  categoryId?: number | null;
  splitType: "equal" | "exact" | "percent" | "shares" | "adjustment";
  participants: Array<{ userId: number; paidMinor: number; input?: number }>;
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

  /** Unauthenticated — the link is often opened in a different browser. */
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

  deleteExpense: (id: number) => request<{ ok: boolean }>(`/expenses/${id}`, { method: "DELETE" }),

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

  // --- reference data -------------------------------------------------------

  listCategories: () =>
    request<{ categories: Array<{ id: number; parent_id: number | null; name: string }> }>(
      "/categories",
    ),

  listCurrencies: () => request<{ currencies: Currency[] }>("/categories/currencies"),

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
 * it from the currencies table via useCurrencies() — never from a guess.
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
