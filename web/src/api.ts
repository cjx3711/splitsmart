/**
 * Native API client.
 *
 * Talks to /api/v1 via Hono's RPC client (`hc<NativeApi>()`), so request and
 * response types come from the server's own routes rather than being retyped
 * here. Money still crosses this boundary as integer minor units.
 *
 * The `api` object is a thin wrapper: credentials, ApiError, and the gzipped
 * sync push. Call sites keep `api.me()` rather than `client.auth.me.$get()`.
 *
 * The split types come from the server's own split engine rather than being
 * retyped here. src/domain/split.ts is pure (no database, no Node built-ins),
 * so the browser can import it, and the add-expense form runs the real
 * computeSplit() to preview a split instead of reimplementing its rounding.
 * See web/src/SplitEditor.tsx.
 */
import { hc } from "hono/client";
import type { InferRequestType, InferResponseType } from "hono/client";
import { displayName as personDisplayName } from "../../src/domain/person.ts";
import type { SplitItem, SplitType } from "../../src/domain/split.ts";
import type { RepeatInterval } from "../../src/domain/recurring.ts";
import type {
  SyncCategory,
  SyncComment,
  SyncCurrency,
  SyncExpense,
  SyncFriendship,
  SyncGroup,
  SyncGroupMember,
  SyncUser,
} from "../../src/domain/sync-types.ts";
import type { NativeApi } from "../../src/routes/native/v1.ts";

export type { SplitItem, SplitType, RepeatInterval };

export const client = hc<NativeApi>("/api/v1", {
  fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { ...init, credentials: "same-origin" })) as typeof fetch,
});

async function toApiError(res: {
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}): Promise<ApiError> {
  let message = res.statusText;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // Non-JSON error body; fall back to the status text.
  }
  return new ApiError(message, res.status);
}

async function rpc(resPromise: Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
}>): Promise<unknown> {
  const res = await resPromise;
  if (!res.ok) throw await toApiError(res);
  return res.json();
}

function call<C extends (...args: never[]) => Promise<unknown>, S extends 200 | 201 = 200>(
  _fn: C,
  res: ReturnType<C>,
  _status?: S,
): Promise<InferResponseType<C, S>> {
  return rpc(res as never) as Promise<InferResponseType<C, S>>;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type MeUser = InferResponseType<typeof client.auth.me.$get, 200>["user"];
/** `/me` always has the verification flags; the Dexie cache of the profile does not. */
export type ApiUser = Omit<MeUser, "emailVerified" | "needsEmailVerification" | "isAdmin"> &
  Partial<Pick<MeUser, "emailVerified" | "needsEmailVerification" | "isAdmin">>;

type GroupsList = InferResponseType<typeof client.groups.$get, 200>;
export type Group = GroupsList["groups"][number];
export type CurrencyAmount = GroupsList["totalBalance"][number];

type GroupDetail = InferResponseType<typeof client.groups[":id"]["$get"], 200>;
export type GroupMember = GroupDetail["members"][number];

type FriendsList = InferResponseType<typeof client.friends.$get, 200>;
export type Friend = FriendsList["friends"][number];
export type FriendBreakdown = Friend["breakdown"][number];

type ExpenseList = InferResponseType<typeof client.expenses.$get, 200>;
type ExpenseSummaryRow = ExpenseList["expenses"][number];
/**
 * A list row. `syncState` is added only when the row came from the offline
 * mirror; network responses do not have it. See docs/OFFLINE.md.
 *
 * `split_type` / `repeat_interval` are strings in SQLite; the editor treats
 * them as the domain unions. `deleted_at` is only present on series lists.
 */
export type ExpenseSummary = Omit<ExpenseSummaryRow, "split_type" | "repeat_interval" | "shares"> & {
  split_type: string;
  repeat_interval?: RepeatInterval | string | null;
  shares: Array<{
    user_id: string;
    paid_share_minor: number;
    owed_share_minor: number;
    split_input?: number | null;
    expense_id?: string;
  }>;
  deleted_at?: string | null;
  syncState?: "synced" | "pending" | "conflict" | "rejected";
};

type ExpenseGet = InferResponseType<typeof client.expenses[":id"]["$get"], 200>;
export type ExpenseDetail = Omit<
  ExpenseGet["expense"],
  "split_type" | "repeat_interval" | "repeat_paused"
> & {
  split_type: SplitType;
  repeat_interval?: RepeatInterval | null;
  repeat_paused?: RepeatInterval | null;
};

type CommentsList = InferResponseType<
  typeof client.expenses[":id"]["comments"]["$get"],
  200
>;
export type Comment = CommentsList["comments"][number];

type ActivityList = InferResponseType<typeof client.activity.$get, 200>;
export type ActivityEntry = ActivityList["activity"][number];

type CurrenciesList = InferResponseType<typeof client.categories.currencies.$get, 200>;
export type Currency = CurrenciesList["currencies"][number];

type LinksList = InferResponseType<typeof client.links.$get, 200>;
export type AccessLink = LinksList["links"][number];

export type ClaimCandidates = InferResponseType<typeof client.claim.candidates.$post, 200>;
export type ClaimPreview = InferResponseType<typeof client.claim.preview.$post, 200>;

export type ImportStatus = InferResponseType<typeof client.import.status.$get, 200>;
export type ImportPreview = InferResponseType<typeof client.import.preview.$post, 200>;
export type ImportPerson = ImportPreview["people"][number];
export type ImportFootprint = ImportStatus["local"];
export type ImportExpensePage = InferResponseType<typeof client.import.expenses.$post, 200>;
export type ImportCommentsPage = InferResponseType<typeof client.import.comments.$post, 200>;
export type ImportRounding = InferResponseType<typeof client.import.rounding.$post, 200>;
export type ImportSkip = ImportExpensePage["skipped"][number];
export type ImportPausedSeries = ImportExpensePage["pausedSeries"][number];

type AdminList = InferResponseType<typeof client.admin.users.$get, 200>;
export type AdminUserUsage = AdminList["users"][number];
export type UsageCounts = AdminUserUsage["counts"];
export type UsageDay = AdminUserUsage["series"][number];

export type ExpenseInput = InferRequestType<typeof client.expenses.$post>["json"];

export type BootstrapResponse = InferResponseType<typeof client.sync.bootstrap.$get, 200>;
export type SnapshotResponse = InferResponseType<typeof client.sync.snapshot.$get, 200>;
export type PullResponse = InferResponseType<typeof client.sync.pull.$get, 200>;
export type PullChange = Omit<PullResponse["changes"][number], "data"> & { data: unknown };
export type PushResultWire = InferResponseType<typeof client.sync.push.$post, 200>["results"][number];

export interface PushOpWire {
  kind: string;
  id: string;
  baseVersion?: number;
  payload?: unknown;
}

/**
 * The filter bar, as a query string.
 *
 * Mirrors src/routes/native/expense-filters.ts one for one, including the
 * `"none"` sentinel for "no group at all". Kept in one place so the three screens
 * that filter cannot each invent their own parameter names.
 */
export interface ExpenseQuery {
  q?: string;
  /** A group id, or "none" for expenses outside any group. */
  groupId?: string;
  /** Only expenses this person is also on. */
  friendId?: string;
  datedAfter?: string;
  datedBefore?: string;
  categoryId?: number;
  isPayment?: boolean;
}

export function expenseQueryString(filters: ExpenseQuery = {}): string {
  const params = wireQuery(filters);
  const query = new URLSearchParams(params).toString();
  return query ? `?${query}` : "";
}

function wireQuery(filters: ExpenseQuery = {}): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.q?.trim()) query.q = filters.q.trim();
  if (filters.groupId) query.group_id = filters.groupId;
  if (filters.friendId) query.friend_id = filters.friendId;
  if (filters.datedAfter) query.dated_after = filters.datedAfter;
  if (filters.datedBefore) query.dated_before = filters.datedBefore;
  if (filters.categoryId !== undefined) query.category_id = String(filters.categoryId);
  if (filters.isPayment !== undefined) query.is_payment = String(filters.isPayment);
  return query;
}

/**
 * POST /sync/push, gzipping the body above a kilobyte.
 *
 * A restaurant bill's itemized payload is small; a catch-up of fifty edits is
 * not. The server gunzips when it sees `Content-Encoding: gzip` (node:zlib).
 * Pull responses are gzipped by the HTTP layer instead - we do not compress
 * them here.
 */
const GZIP_THRESHOLD = 1024;

async function pushRequest(
  payload: unknown,
): Promise<InferResponseType<typeof client.sync.push.$post, 200>> {
  const json = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let body: BodyInit = json;

  if (json.length >= GZIP_THRESHOLD && typeof CompressionStream !== "undefined") {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    body = await new Response(stream).arrayBuffer();
    headers["Content-Encoding"] = "gzip";
  }

  const res = await fetch("/api/v1/sync/push", {
    method: "POST",
    body,
    headers,
    credentials: "same-origin",
  });
  if (!res.ok) throw await toApiError(res);
  return res.json() as Promise<InferResponseType<typeof client.sync.push.$post, 200>>;
}

export const api = {
  signup: (input: InferRequestType<typeof client.auth.signup.$post>["json"]) =>
    call(client.auth.signup.$post, client.auth.signup.$post({ json: input })),

  register: (input: InferRequestType<typeof client.auth.register.$post>["json"]) =>
    call(client.auth.register.$post, client.auth.register.$post({ json: input }), 201),

  login: (email: string, password: string) =>
    call(client.auth.login.$post, client.auth.login.$post({ json: { email, password } })),

  logout: () => call(client.auth.logout.$post, client.auth.logout.$post()),

  /** Unauthenticated; the link is often opened in a different browser. */
  verifyEmail: (token: string) =>
    call(client.auth.verify[":token"].$post, client.auth.verify[":token"].$post({ param: { token } })),

  resendVerification: () =>
    call(client.auth.verify.resend.$post, client.auth.verify.resend.$post()),

  me: () => call(client.auth.me.$get, client.auth.me.$get()),

  updateMe: (input: InferRequestType<typeof client.auth.me.$patch>["json"]) =>
    call(client.auth.me.$patch, client.auth.me.$patch({ json: input })),

  listTokens: () => call(client.auth.tokens.$get, client.auth.tokens.$get()),

  createToken: (name: string) =>
    call(client.auth.tokens.$post, client.auth.tokens.$post({ json: { name } }), 201),

  revokeToken: (id: string) =>
    call(client.auth.tokens[":id"].$delete, client.auth.tokens[":id"].$delete({ param: { id } })),

  listGroups: () => call(client.groups.$get, client.groups.$get()),

  createGroup: (input: InferRequestType<typeof client.groups.$post>["json"]) =>
    call(client.groups.$post, client.groups.$post({ json: input }), 201),

  getGroup: (id: string) =>
    call(client.groups[":id"].$get, client.groups[":id"].$get({ param: { id } })),

  updateGroup: (
    id: string,
    input: InferRequestType<typeof client.groups[":id"]["$patch"]>["json"],
  ) =>
    call(client.groups[":id"].$patch, client.groups[":id"].$patch({ param: { id }, json: input })),

  addGroupMember: (
    groupId: string,
    input: InferRequestType<typeof client.groups[":id"]["members"]["$post"]>["json"],
  ) =>
    call(
      client.groups[":id"].members.$post,
      client.groups[":id"].members.$post({ param: { id: groupId }, json: input }),
      201,
    ),

  removeGroupMember: (groupId: string, userId: string) =>
    call(
      client.groups[":id"].members[":userId"].$delete,
      client.groups[":id"].members[":userId"].$delete({ param: { id: groupId, userId } }),
    ),

  getGroupExpenses: (id: string, filters?: ExpenseQuery) =>
    call(
      client.groups[":id"].expenses.$get,
      client.groups[":id"].expenses.$get({ param: { id }, query: wireQuery(filters) }),
    ),

  getSettleSuggestions: (id: string) =>
    call(client.groups[":id"].settle.$get, client.groups[":id"].settle.$get({ param: { id } })),

  createExpense: (
    groupId: string,
    input: InferRequestType<typeof client.groups[":id"]["expenses"]["$post"]>["json"],
  ) =>
    call(
      client.groups[":id"].expenses.$post,
      client.groups[":id"].expenses.$post({ param: { id: groupId }, json: input }),
      201,
    ),

  createGroupPayment: (
    groupId: string,
    input: InferRequestType<typeof client.groups[":id"]["payments"]["$post"]>["json"],
  ) =>
    call(
      client.groups[":id"].payments.$post,
      client.groups[":id"].payments.$post({ param: { id: groupId }, json: input }),
      201,
    ),

  /**
   * The one the add-expense dialog uses: any set of people, group or no group.
   * The group- and friend-scoped creates above stay for the narrower callers.
   */
  createAnyExpense: (input: ExpenseInput) =>
    call(client.expenses.$post, client.expenses.$post({ json: input }), 201),

  deleteExpense: (id: string) =>
    call(client.expenses[":id"].$delete, client.expenses[":id"].$delete({ param: { id } })),

  /** Undoes a delete. The tombstone was always recoverable; this is the undo. */
  restoreExpense: (id: string) =>
    call(client.expenses[":id"].restore.$post, client.expenses[":id"].restore.$post({ param: { id } })),

  getExpense: (id: string) =>
    call(client.expenses[":id"].$get, client.expenses[":id"].$get({ param: { id } })),

  updateExpense: (id: string, input: ExpenseInput) =>
    call(client.expenses[":id"].$patch, client.expenses[":id"].$patch({ param: { id }, json: input })),

  listExpenses: (filters?: ExpenseQuery) =>
    call(client.expenses.$get, client.expenses.$get({ query: wireQuery(filters) })),

  /**
   * A URL, not a fetch: the browser downloads it, and the session cookie goes
   * along for the ride. Reading it into memory to re-save it would buy nothing.
   */
  expensesCsvUrl: (filters?: ExpenseQuery) => `/api/v1/expenses.csv${expenseQueryString(filters)}`,

  listComments: (expenseId: string) =>
    call(
      client.expenses[":id"].comments.$get,
      client.expenses[":id"].comments.$get({ param: { id: expenseId } }),
    ),

  addComment: (expenseId: string, content: string) =>
    call(
      client.expenses[":id"].comments.$post,
      client.expenses[":id"].comments.$post({ param: { id: expenseId }, json: { content } }),
      201,
    ),

  deleteComment: (id: string) =>
    call(client.comments[":id"].$delete, client.comments[":id"].$delete({ param: { id } })),

  listActivity: () => call(client.activity.$get, client.activity.$get()),

  listFriends: () => call(client.friends.$get, client.friends.$get()),

  getFriend: (id: string) =>
    call(client.friends[":id"].$get, client.friends[":id"].$get({ param: { id } })),

  updateFriend: (
    id: string,
    input: InferRequestType<typeof client.friends[":id"]["$patch"]>["json"],
  ) => call(client.friends[":id"].$patch, client.friends[":id"].$patch({ param: { id }, json: input })),

  addFriend: (input: InferRequestType<typeof client.friends.$post>["json"]) =>
    call(client.friends.$post, client.friends.$post({ json: input }), 201),

  removeFriend: (id: string) =>
    call(client.friends[":id"].$delete, client.friends[":id"].$delete({ param: { id } })),

  getFriendExpenses: (id: string, filters?: ExpenseQuery) =>
    call(
      client.friends[":id"].expenses.$get,
      client.friends[":id"].expenses.$get({ param: { id }, query: wireQuery(filters) }),
    ),

  createFriendExpense: (
    friendId: string,
    input: InferRequestType<typeof client.friends[":id"]["expenses"]["$post"]>["json"],
  ) =>
    call(
      client.friends[":id"].expenses.$post,
      client.friends[":id"].expenses.$post({ param: { id: friendId }, json: input }),
      201,
    ),

  createFriendPayment: (
    friendId: string,
    input: InferRequestType<typeof client.friends[":id"]["payments"]["$post"]>["json"],
  ) =>
    call(
      client.friends[":id"].payments.$post,
      client.friends[":id"].payments.$post({ param: { id: friendId }, json: input }),
      201,
    ),

  importStatus: () => call(client.import.status.$get, client.import.status.$get()),

  importPreview: (apiKey: string) =>
    call(client.import.preview.$post, client.import.preview.$post({ json: { apiKey } })),

  importFriends: (apiKey: string) =>
    call(client.import.friends.$post, client.import.friends.$post({ json: { apiKey } })),

  importGroups: (apiKey: string) =>
    call(client.import.groups.$post, client.import.groups.$post({ json: { apiKey } })),

  /** One page. Feed `nextOffset` back in until `done`. */
  importExpenses: (apiKey: string, offset = 0, limit = 500) =>
    call(
      client.import.expenses.$post,
      client.import.expenses.$post({ json: { apiKey, offset, limit } }),
    ),

  /**
   * Step 4. Safe to call even when Splitwise nested the comments on the expense
   * payload: those are already in and stamped, so this walks past them.
   */
  importComments: (apiKey: string, offset = 0, limit = 200) =>
    call(
      client.import.comments.$post,
      client.import.comments.$post({ json: { apiKey, offset, limit } }),
    ),

  /**
   * Step 5. Compares Splitwise friend totals with ours and records settle-ups
   * for leftover cents from dropped fractions. Safe to call twice: a match is
   * a no-op.
   */
  importRounding: (apiKey: string) =>
    call(client.import.rounding.$post, client.import.rounding.$post({ json: { apiKey } })),

  /** Resume stopped series that import landed from Splitwise repeating bills. */
  importContinueRecurring: (ids: string[]) =>
    call(
      client.import["continue-recurring"].$post,
      client.import["continue-recurring"].$post({ json: { ids } }),
    ),

  /** Hard-delete this account's ledger. Confirmation must be the exact phrase. */
  importWipe: (confirm: "DELETE ALL DATA") =>
    call(client.import.wipe.$post, client.import.wipe.$post({ json: { confirm } })),

  listCategories: () => call(client.categories.$get, client.categories.$get()),

  listCurrencies: () => call(client.categories.currencies.$get, client.categories.currencies.$get()),

  /** Currencies the caller has actually used, most-used first. */
  frequentCurrencies: () =>
    call(client.expenses.currencies.frequent.$get, client.expenses.currencies.frequent.$get()),

  listLinks: (query: { groupId: string } | { friendId: string }) =>
    call(
      client.links.$get,
      client.links.$get({
        query: "groupId" in query ? { groupId: query.groupId } : { friendId: query.friendId },
      }),
    ),

  mintLink: (input: InferRequestType<typeof client.links.$post>["json"]) =>
    call(client.links.$post, client.links.$post({ json: input }), 201),

  revokeLink: (id: string) =>
    call(client.links[":id"].$delete, client.links[":id"].$delete({ param: { id } })),

  claimCandidates: (linkToken: string) =>
    call(client.claim.candidates.$post, client.claim.candidates.$post({ json: { linkToken } })),

  claimPreview: (linkToken: string, userId: string) =>
    call(client.claim.preview.$post, client.claim.preview.$post({ json: { linkToken, userId } })),

  claim: (linkToken: string, userId: string) =>
    call(client.claim.$post, client.claim.$post({ json: { linkToken, userId } })),

  syncBootstrap: (cursor?: string | null) =>
    call(client.sync.bootstrap.$get, client.sync.bootstrap.$get({ query: cursor ? { cursor } : {} })),

  syncPull: (since: number, limit?: number) =>
    call(
      client.sync.pull.$get,
      client.sync.pull.$get({
        query: {
          since: String(since),
          ...(limit === undefined ? {} : { limit: String(limit) }),
        },
      }),
    ),

  syncSnapshotGroup: (groupId: string) =>
    call(client.sync.snapshot.$get, client.sync.snapshot.$get({ query: { group_id: groupId } })),

  syncSnapshotExpense: (expenseId: string) =>
    call(client.sync.snapshot.$get, client.sync.snapshot.$get({ query: { expense_id: expenseId } })),

  syncPush: (ops: PushOpWire[]) => pushRequest({ ops }),

  adminUsers: (opts?: { q?: string; asOf?: string }) =>
    call(
      client.admin.users.$get,
      client.admin.users.$get({
        query: {
          ...(opts?.q ? { q: opts.q } : {}),
          ...(opts?.asOf ? { as_of: opts.asOf } : {}),
        },
      }),
    ),

  adminUser: (id: string, opts?: { asOf?: string }) =>
    call(
      client.admin.users[":id"].$get,
      client.admin.users[":id"].$get({
        param: { id },
        query: opts?.asOf ? { as_of: opts.asOf } : {},
      }),
    ),
};

// Re-exported so existing imports of these sync entity types from api.ts keep
// compiling. The wire shapes live in src/domain/sync-types.ts.
export type {
  SyncCategory,
  SyncComment,
  SyncCurrency,
  SyncExpense,
  SyncFriendship,
  SyncGroup,
  SyncGroupMember,
  SyncUser,
};

// --- money formatting -------------------------------------------------------

/**
 * Minor units -> display string. Mirrors src/domain/money.ts formatAmount.
 *
 * `decimalPlaces` is required rather than defaulting to 2, because defaulting
 * is how JPY ends up displayed as one hundredth of its real value. Callers get
 * it from the currencies table via useCurrencies(); never from a guess.
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

/** Nickname if set, otherwise the name. */
export function displayName(person: { name: string; nickname?: string | null }): string {
  return personDisplayName(person);
}

/** @deprecated Use displayName. Kept as an alias for call sites mid-migration. */
export function fullName(person: { name: string; nickname?: string | null }): string {
  return displayName(person);
}
