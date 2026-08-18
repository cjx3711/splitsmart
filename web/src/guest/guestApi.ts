/**
 * The guest API client. Talks only to /api/v1/guest.
 *
 * Every request carries the link secret as `Authorization: Bearer link_<...>`
 * and the picked name as a header, because the server keeps no guest state at
 * all. `credentials: "omit"` is deliberate: if the same browser also has an app
 * session cookie, sending it here would let a guest page quietly act as the
 * logged-in user, which is the opposite of what a scoped link is for.
 *
 * Three failure shapes the caller has to tell apart, and the shell renders a
 * different screen for each:
 *
 *   GuestLinkError    401. The link is finished. Ask for a new one, or log in.
 *   GuestPickerError  409. The link is fine; nobody has said who they are.
 *   GuestOfflineError fetch itself failed. NOT a cached ledger; a
 *                     needs-connection screen. See docs/GUEST.md.
 */
import {
  displayName,
  type Comment,
  type Currency,
  type CurrencyAmount,
  type ExpenseInput,
  type ExpenseSummary,
  type ExpenseDetail,
} from "../api.ts";
import { readActingAs, readGuestLink } from "./guestStorage.ts";

export type GuestLinkFailure = "invalid" | "expired" | "revoked" | "claimed" | "gone";

export class GuestLinkError extends Error {
  constructor(
    message: string,
    readonly reason: GuestLinkFailure,
  ) {
    super(message);
  }
}

/** The link works; the holder has not picked which name they are. */
export class GuestPickerError extends Error {}

/** The network is gone. The guest app has nothing cached, and says so. */
export class GuestOfflineError extends Error {
  constructor() {
    super("You need a connection to see this.");
  }
}

export class GuestApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const secret = readGuestLink();
  if (!secret) throw new GuestLinkError("No link on this device.", "invalid");

  const actingAs = readActingAs();

  let res: Response;
  try {
    res = await fetch(`/api/v1/guest${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer link_${secret}`,
        ...(actingAs ? { "X-SplitSmart-Acting-As": actingAs } : {}),
        ...(init.headers ?? {}),
      },
      // Never the session cookie. See the note at the top of this file.
      credentials: "omit",
    });
  } catch {
    throw new GuestOfflineError();
  }

  if (res.ok) return res.json() as Promise<T>;

  let body: { error?: string; reason?: GuestLinkFailure; needsPicker?: boolean } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // Non-JSON error body; fall through to the status text.
  }

  if (res.status === 401) {
    throw new GuestLinkError(body.error ?? res.statusText, body.reason ?? "invalid");
  }
  if (res.status === 409 && body.needsPicker) {
    throw new GuestPickerError(body.error ?? "Pick who you are first.");
  }

  throw new GuestApiError(body.error ?? res.statusText, res.status);
}

// ---------------------------------------------------------------------------

export interface GuestPerson {
  id: string;
  name: string;
  nickname: string | null;
  iconLetters: string | null;
  iconEmoji: string | null;
  iconHue: number | null;
}

export interface GuestGroupSummary {
  id: string;
  name: string;
  group_type: string;
  default_currency: string;
}

export interface GuestSession {
  kind: "group" | "group_member" | "friend";
  /** True for a general group link: the holder may swap names at any time. */
  canRepick: boolean;
  /** True until a name has been picked. The shell shows the picker instead. */
  needsPicker: boolean;
  expiresAt: string | null;
  people: GuestPerson[];
  actingAs: (GuestPerson & { defaultCurrency: string }) | null;
  /** The bound group, for group and group_member links. */
  group: GuestGroupSummary | null;
  /** Every group in scope. One for a group link; the ghost's for a friend one. */
  groups: GuestGroupSummary[];
  /** The owner, on a friend link. Null otherwise. */
  counterpart: GuestPerson | null;
}

export interface GuestMember {
  id: string;
  name: string;
  nickname: string | null;
  icon_letters: string | null;
  icon_emoji: string | null;
  icon_hue: number | null;
  is_ghost: number;
  role: string;
  joined_via: string;
}

export type GuestVisiblePerson = {
  id: string;
  name: string;
  nickname: string | null;
  icon_letters: string | null;
  icon_emoji: string | null;
  icon_hue: number | null;
  is_ghost: number;
};

export const guestApi = {
  session: () => request<GuestSession>("/session"),

  currencies: () => request<{ currencies: Currency[] }>("/currencies"),

  people: () => request<{ people: GuestVisiblePerson[] }>("/people"),

  group: (id: string) =>
    request<{
      group: GuestGroupSummary & { simplify_by_default: number };
      members: GuestMember[];
      balances: Array<{ userId: string; balances: CurrencyAmount[] }>;
      expenses: ExpenseSummary[];
    }>(`/groups/${id}`),

  settleSuggestions: (id: string) =>
    request<{
      suggestions: Array<{
        currencyCode: string;
        transfers: Array<{ fromUserId: string; toUserId: string; amountMinor: number }>;
      }>;
    }>(`/groups/${id}/settle`),

  friend: () =>
    request<{
      counterpart: {
        id: string;
        name: string;
        nickname: string | null;
        icon_letters: string | null;
        icon_emoji: string | null;
        icon_hue: number | null;
      };
      balances: CurrencyAmount[];
      expenses: ExpenseSummary[];
    }>("/friend"),

  expenses: () => request<{ expenses: ExpenseSummary[] }>("/expenses"),

  expense: (id: string) => request<{ expense: ExpenseDetail }>(`/expenses/${id}`),

  createExpense: (input: ExpenseInput & { groupId: string | null }) =>
    request<{ id: string }>("/expenses", { method: "POST", body: JSON.stringify(input) }),

  updateExpense: (id: string, input: ExpenseInput & { groupId: string | null }) =>
    request<{ ok: boolean }>(`/expenses/${id}`, { method: "PATCH", body: JSON.stringify(input) }),

  deleteExpense: (id: string) =>
    request<{ ok: boolean }>(`/expenses/${id}`, { method: "DELETE" }),

  createPayment: (input: {
    groupId: string | null;
    fromUserId: string;
    toUserId: string;
    amountMinor: number;
    currencyCode: string;
    date?: string;
  }) => request<{ id: string }>("/payments", { method: "POST", body: JSON.stringify(input) }),

  // --- comments -------------------------------------------------------------
  //
  // A guest who can read a bill can talk about it, as the person the link acts
  // as. They can delete their own notes and nobody else's, and generated system
  // comments are not deletable by anyone. All three rules live server-side.

  comments: (expenseId: string) =>
    request<{ comments: Comment[] }>(`/expenses/${expenseId}/comments`),

  addComment: (expenseId: string, content: string) =>
    request<{ comment: Comment | null }>(`/expenses/${expenseId}/comments`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),

  deleteComment: (id: string) => request<{ ok: boolean }>(`/comments/${id}`, { method: "DELETE" }),
};

export function guestFullName(person: { name: string; nickname?: string | null }): string {
  return displayName(person);
}
