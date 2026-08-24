/**
 * The local mirror: Dexie over IndexedDB.
 *
 * This is what makes the logged-in app work with no network. It holds the
 * caller's visible ledger as documents in the shapes `/api/v1/sync/*` delivers
 * (src/domain/sync-types.ts), plus an explicit outbox of writes waiting to go
 * out, plus a small `meta` table for the cursor, the last-synced time and the
 * cached profile.
 *
 * THREE RULES, and each of them is load-bearing rather than stylistic.
 *
 * 1. **The database name is namespaced by user id.** `splitsmart-<userId>`.
 *    Two accounts on one browser must not share a ledger, and - more importantly
 *    - a *guest link* must never be used as a namespace. Which brings us to:
 *
 * 2. **A guest-link visitor never opens this.** Nothing under web/src/guest/
 *    imports this module, and there is no code path that would let it: a link is
 *    a capability its owner can expire at any moment, and a cached ledger is not
 *    revocable. See docs/GUEST.md.
 *
 * 3. **Balances are never stored, only derived.** There is no balances table and
 *    there must not be one. `web/src/db/queries.ts` runs the real
 *    `deriveRepayments` over the shares held here, because a pairwise net taken
 *    from two people's paid/owed on a three-way bill is simply wrong. The
 *    stored pairing arrives on the expense as `repayments` and is a hint, the
 *    same way the server passes Splitwise's `repayments[]` into `createExpense`.
 *
 * Dexie rather than raw IndexedDB for `liveQuery` (every screen re-renders when
 * a sync lands, with no cache-invalidation code of our own), versioned schema
 * migrations, multi-store transactions and compound indexes. Not
 * `dexie-syncable`, not `db.on('changes')`, and not `dexie-cloud-addon`: the
 * outbox here is explicit and its reducer is a pure function that can be tested
 * without a browser.
 */
import Dexie, { type EntityTable } from "dexie";
import { clearFriendRecency } from "./friendRecencyCache.ts";
import type {
  SyncCategory,
  SyncComment,
  SyncCurrency,
  SyncExpense,
  SyncFriendship,
  SyncGroup,
  SyncGroupMember,
  SyncUser,
} from "../../../src/domain/sync-types.ts";

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

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * How far a local row has got towards the server.
 *
 * `synced` is the server's own version of the row. `pending` has an outbox entry
 * waiting. `conflict` means push came back with somebody else's newer row and a
 * person has to choose. `rejected` means the server refused it outright - an
 * unknown currency, a departed member - and it is sitting in quarantine rather
 * than silently gone, because an expense that vanishes between devices is worse
 * than an error message.
 */
export type SyncState = "synced" | "pending" | "conflict" | "rejected";

/**
 * An expense in the mirror.
 *
 * The sync document plus two local-only fields. `shares` and `people` stay nested
 * arrays rather than being normalised into their own tables: they are always read
 * with the expense, they are rewritten wholesale on every write (the server
 * deletes and reinserts them too), and a compound-key join table would buy
 * nothing but a second place for them to disagree.
 *
 * `serverVersion` is what a later edit sends as `baseVersion`. It is the version
 * the row was at when it last came FROM the server, and it does not move when a
 * local edit is queued - an optimistic bump would make the conflict check
 * compare the wrong number.
 */
export interface LocalExpense extends SyncExpense {
  syncState: SyncState;
  /**
   * The server row this local copy diverged from, kept while `syncState` is
   * `conflict` so the resolution screen can show both. Null otherwise.
   */
  conflictWith?: SyncExpense | null;
  /** Why the server refused it. Set only when `syncState` is `rejected`. */
  rejectedReason?: string | null;
}

export interface LocalComment extends SyncComment {
  syncState: SyncState;
}

export interface LocalGroupMember extends SyncGroupMember {
  /** `${groupId}:${userId}` - a junction table has no id of its own. */
  key: string;
}

export interface LocalFriendship extends SyncFriendship {
  /** `${userAId}:${userBId}`, already canonical, so a pair can only exist once. */
  key: string;
}

/**
 * One queued write.
 *
 * `seq` is Dexie's autoincrement and is the push order within a batch, which is
 * why the reducer replaces an entry's payload in place rather than deleting and
 * re-adding it: a re-added entry would jump to the back of the queue and could
 * end up pushed after a comment that depends on it.
 *
 * `baseVersion` is frozen at the FIRST local edit, delete or restore of a synced
 * row, and deliberately not touched again however many times the user then
 * changes their mind. It is "the version I was looking at when I started".
 */
export interface OutboxOp {
  seq?: number;
  /** Expense or comment ULID. One pending op per entity, enforced by the reducer. */
  id: string;
  kind: OutboxKind;
  /** Absent for creates (which cannot conflict) and for every comment op. */
  baseVersion?: number | null;
  /** The body to send. Shape depends on `kind`; see web/src/sync/outbox.ts. */
  payload: unknown;
  status: "pending" | "conflict" | "rejected";
  reason?: string | null;
  /** Advisory only. The server stamps what it accepts; this is never a tiebreak. */
  queuedAt: string;
}

export type OutboxKind =
  | "expense.create"
  | "expense.update"
  | "expense.delete"
  | "expense.restore"
  | "payment.create"
  | "comment.create"
  | "comment.delete";

/**
 * The `meta` table: single rows, looked up by a literal key.
 *
 * Keyed by a mapped type rather than `unknown` so a typo is a compile error and
 * `getMeta("cursor")` is a number without a cast at the call site.
 */
export interface MetaValues {
  /** The pull cursor: the highest `sync_log.seq` this device has applied. */
  cursor: number;
  /** The last SUCCESSFUL sync. Not the last attempt; the UI says "last synced". */
  lastSyncedAt: string;
  /** Why the last attempt failed, for the offline indicator. Null when fine. */
  lastError: string | null;
  /** False until a full bootstrap has finished draining its pages. */
  bootstrapped: boolean;
  /**
   * Shape of group documents in this mirror. Bumped when a field is added that
   * existing rows will not have (pull does not rewrite unchanged groups).
   * 1 = `simplifyByDefault` has been stamped from the server.
   */
  groupShape: number;
  /**
   * Shape of expense documents in this mirror. Bumped when a field is added
   * that pull will not rewrite on an unchanged bill.
   * 1 = `repayments` (the stored pairing) has been stamped from bootstrap.
   */
  expenseShape: number;
  /** The cached profile, so a reload with no network renders the app. */
  profile: SyncUser;
  /**
   * Bumped when the per-user localStorage recency map changes (friends and
   * groups), so Dexie live queries that sort the rail re-run without opening
   * the expense store.
   */
  friendRecencyRev: number;
}

export type MetaKey = keyof MetaValues;

export interface MetaRow {
  key: MetaKey;
  value: MetaValues[MetaKey];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export type LocalDb = Dexie & {
  expenses: EntityTable<LocalExpense, "id">;
  comments: EntityTable<LocalComment, "id">;
  groups: EntityTable<SyncGroup, "id">;
  groupMembers: EntityTable<LocalGroupMember, "key">;
  users: EntityTable<SyncUser, "id">;
  friendships: EntityTable<LocalFriendship, "key">;
  currencies: EntityTable<SyncCurrency, "code">;
  categories: EntityTable<SyncCategory, "id">;
  outbox: EntityTable<OutboxOp, "seq">;
  meta: EntityTable<MetaRow, "key">;
};

/**
 * Opens (and creates) the mirror for one account.
 *
 * The indexes are exactly the ones web/src/db/queries.ts reads by, and no more.
 * An index on IndexedDB costs a write on every put, and the collections here are
 * small enough that a scan over a non-indexed field is cheaper than maintaining
 * an index nothing sorts on.
 *
 * `deletedAt` is indexed as a plain field even though IndexedDB cannot index
 * null: Dexie simply omits null-valued rows from that index, which is why the
 * live-expense queries filter in JavaScript rather than trusting `equals(null)`.
 */
export function localDbName(userId: string): string {
  return `splitsmart-${userId}`;
}

export function openLocalDb(userId: string): LocalDb {
  const db = new Dexie(localDbName(userId)) as LocalDb;

  db.version(1).stores({
    expenses: "id, groupId, date, syncState, repeatOf",
    comments: "id, expenseId, createdAt, syncState",
    groups: "id, name",
    groupMembers: "key, groupId, userId",
    users: "id, email",
    friendships: "key, userAId, userBId",
    currencies: "code",
    categories: "id, parentId",
    outbox: "++seq, id, kind, status",
    meta: "key",
  });

  return db;
}

/** Drops the mirror for one account. Close the live Dexie first. */
export async function deleteLocalDb(userId: string): Promise<void> {
  clearFriendRecency(userId);
  await Dexie.delete(localDbName(userId));
}

// ---------------------------------------------------------------------------
// meta helpers
// ---------------------------------------------------------------------------

/**
 * Reads a `meta` value, or a fallback.
 *
 * The cast is contained here rather than at every call site: Dexie cannot express
 * "the value type depends on the key", and the union above is what keeps callers
 * honest.
 */
export async function getMeta<K extends MetaKey>(
  db: LocalDb,
  key: K,
): Promise<MetaValues[K] | undefined> {
  const row = await db.meta.get(key);
  return row?.value as MetaValues[K] | undefined;
}

export async function setMeta<K extends MetaKey>(
  db: LocalDb,
  key: K,
  value: MetaValues[K],
): Promise<void> {
  await db.meta.put({ key, value });
}

/** `${groupId}:${userId}`. The one place this key is spelled. */
export function memberKey(groupId: string, userId: string): string {
  return `${groupId}:${userId}`;
}

/** The friendships key. Already-canonical ids in, so no reordering here. */
export function friendshipKey(userAId: string, userBId: string): string {
  return `${userAId}:${userBId}`;
}
