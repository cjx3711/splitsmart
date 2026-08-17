/**
 * Read-only client for the real Splitwise API.
 *
 * This is the ONLY module that talks to secure.splitwise.com. It is read-only
 * on purpose: importing must never be able to mutate the account it is reading
 * from, so there are no POST helpers here and there must not be.
 *
 * THE API KEY IS NEVER PERSISTED. It arrives on the request that needs it, is
 * held in a local, and goes out of scope when the handler returns. There is no
 * column for it, no env var read at request time, and no logging of it. See
 * `redact()` below, which scrubs it out of upstream error bodies before they
 * reach a user or a log line.
 *
 * `baseUrl` defaults to `env.SPLITWISE_API_BASE`, which exists so a test (or an
 * agent) can point the importer at a fake Splitwise on localhost and drive the
 * whole flow end to end without a real account. Nothing else should change it.
 */
import { env } from "../env.ts";

export class SplitwiseError extends Error {
  // Assigned in the body, NOT declared as a constructor parameter property.
  // `--experimental-strip-types` runs these files with no build step and
  // rejects parameter properties outright (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX),
  // so `readonly status: number` in the signature takes the whole server down.
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** A bad or revoked key. Separated because the UI must say "check your key". */
export class SplitwiseAuthError extends SplitwiseError {}

export interface SplitwiseUser {
  id: number;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  default_currency?: string | null;
  registration_status?: string | null;
  picture?: { medium?: string | null; large?: string | null } | null;
  created_at?: string | null;
}

export interface SplitwiseGroup {
  id: number;
  name: string;
  group_type?: string | null;
  simplify_by_default?: boolean | null;
  members?: SplitwiseUser[];
  created_at?: string | null;
}

export interface SplitwiseExpenseUser {
  user_id?: number;
  user?: SplitwiseUser;
  paid_share: string;
  owed_share: string;
}

/**
 * A comment on an expense, as Splitwise returns it.
 *
 * `comment_type` is `"User"` or `"System"` — capitalised, and the reason the
 * importer maps rather than trusting the string. System rows are the edit history
 * of the bill ("Jane updated this transaction: ..."), and they are the only
 * edit history Splitwise will ever give us, so they are imported too.
 */
export interface SplitwiseComment {
  id: number;
  content: string;
  comment_type?: string | null;
  relation_type?: string | null;
  relation_id?: number | null;
  created_at?: string | null;
  deleted_at?: string | null;
  user?: SplitwiseUser | null;
}

export interface SplitwiseExpense {
  id: number;
  group_id?: number | null;
  description: string;
  details?: string | null;
  payment?: boolean;
  cost: string;
  currency_code: string;
  date: string;
  created_at?: string | null;
  updated_at?: string | null;
  category?: { id: number; name: string } | null;
  deleted_at?: string | null;
  users?: SplitwiseExpenseUser[];
  /**
   * Present on `get_expenses` even when `comments[]` is not, which is exactly
   * why the importer reads it: an expense whose count is 0 never needs a second
   * request, and one with a count but no nested array does.
   */
  comments_count?: number | null;
  /**
   * Nested comments, IF this deployment of Splitwise sends them on the list.
   * Ours may not; see `getComments` below and docs/PARITY.md, "Capture what
   * import will need". The importer handles both shapes rather than betting on
   * one, because the fixture that would settle it can only be captured against a
   * live account while the API is still free.
   */
  comments?: SplitwiseComment[];
  /** Splitwise's recurrence fields. Read for the preview warning ONLY. */
  repeats?: boolean | null;
  repeat_interval?: string | null;
  next_repeat?: string | null;
  /** Receipts are never imported (CLAUDE.md, "No file uploads"). */
  receipt?: { original?: string | null; large?: string | null } | null;
}

export interface SplitwiseClientOptions {
  apiKey: string;
  /** Overrides `env.SPLITWISE_API_BASE`. Tests point this at a local fake. */
  baseUrl?: string;
  /** Injectable for tests that would rather not open a socket at all. */
  fetchImpl?: typeof fetch;
  /**
   * Courtesy delay between paged requests. Zero in tests; the default keeps a
   * full import from looking like abuse to Splitwise's rate limiter.
   */
  requestDelayMs?: number;
}

/** Splitwise caps page size server-side; trust the returned length, not this. */
export const EXPENSE_PAGE_SIZE = 100;

export class SplitwiseClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestDelayMs: number;

  constructor(options: SplitwiseClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? env.SPLITWISE_API_BASE).replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestDelayMs = options.requestDelayMs ?? 0;
  }

  async getCurrentUser(): Promise<SplitwiseUser> {
    const body = await this.get<{ user?: SplitwiseUser }>("/get_current_user");
    if (!body.user?.id) {
      throw new SplitwiseError("Splitwise did not return an account for that key", 502);
    }
    return body.user;
  }

  async getGroups(): Promise<SplitwiseGroup[]> {
    const body = await this.get<{ groups?: SplitwiseGroup[] }>("/get_groups");
    return body.groups ?? [];
  }

  async getFriends(): Promise<SplitwiseUser[]> {
    const body = await this.get<{ friends?: SplitwiseUser[] }>("/get_friends");
    return body.friends ?? [];
  }

  /**
   * One page of expenses, oldest-offset-first.
   *
   * Splitwise defaults to only recent expenses unless `dated_after` is absent
   * and `limit`/`offset` are explicit, which is why both are always sent.
   */
  async getExpenses(params: { limit?: number; offset?: number } = {}): Promise<SplitwiseExpense[]> {
    const limit = params.limit ?? EXPENSE_PAGE_SIZE;
    const offset = params.offset ?? 0;
    const body = await this.get<{ expenses?: SplitwiseExpense[] }>(
      `/get_expenses?limit=${limit}&offset=${offset}`,
    );
    return body.expenses ?? [];
  }

  /**
   * Comments on one expense.
   *
   * Needed because `get_expenses` may or may not nest them: this is the fallback
   * that makes comment import work either way, and the paged
   * `POST /api/v1/import/comments` step is built on it. Still read-only — there
   * is no `create_comment` here and there must not be.
   */
  async getComments(expenseId: number): Promise<SplitwiseComment[]> {
    const body = await this.get<{ comments?: SplitwiseComment[] }>(
      `/get_comments?expense_id=${expenseId}`,
    );
    return body.comments ?? [];
  }

  /** Courtesy delay between paged requests, for callers that loop. */
  async wait(): Promise<void> {
    await this.pause();
  }

  /**
   * Counts expenses by walking pages and discarding them.
   *
   * Splitwise has no count endpoint. This is only used by the preview step, so
   * it is capped; an exact number matters less there than not spending two
   * minutes before the user has agreed to anything.
   */
  async countExpenses(cap = 5_000): Promise<{ count: number; capped: boolean }> {
    let count = 0;
    for (let offset = 0; offset < cap; offset += EXPENSE_PAGE_SIZE) {
      const page = await this.getExpenses({ limit: EXPENSE_PAGE_SIZE, offset });
      count += page.length;
      if (page.length < EXPENSE_PAGE_SIZE) return { count, capped: false };
      await this.pause();
    }
    return { count, capped: true };
  }

  private async pause(): Promise<void> {
    if (this.requestDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.requestDelayMs));
    }
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
      });
    } catch (err) {
      // A DNS or TLS failure is not the user's key being wrong; say so plainly
      // rather than sending them off to regenerate a working key.
      throw new SplitwiseError(
        `Could not reach Splitwise: ${this.redact(err instanceof Error ? err.message : String(err))}`,
        502,
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new SplitwiseAuthError(
        "Splitwise rejected that API key. Check it at https://secure.splitwise.com/apps.",
        res.status,
      );
    }

    if (!res.ok) {
      const detail = this.redact((await res.text().catch(() => "")).slice(0, 500));
      throw new SplitwiseError(
        `Splitwise ${path} returned ${res.status}${detail ? `: ${detail}` : ""}`,
        res.status === 429 ? 429 : 502,
      );
    }

    try {
      return (await res.json()) as T;
    } catch {
      throw new SplitwiseError(`Splitwise ${path} returned a non-JSON body`, 502);
    }
  }

  /** Upstream errors sometimes echo the request; never let the key back out. */
  private redact(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join("[redacted]") : text;
  }
}
