/**
 * The wire shapes `/api/v1/sync/*` speaks.
 *
 * PURE TYPES. The only import is a type (the avatar pattern), so this stays
 * free of I/O. Imported by BOTH sides -
 * src/routes/native/sync-serializers.ts builds these, and web/src/db/local.ts
 * stores them - for the same reason src/domain/split.ts is shared: one definition
 * cannot drift from itself, and the first symptom of drift here would be a field
 * the client silently never reads.
 *
 * ENTITIES ARE WHOLE. No field-level diffs, ever. A change delivers the current
 * document and the client replaces its copy, which is what makes applying the
 * same change twice a no-op and makes "two pages both contain this row" a
 * question with a boring answer.
 *
 * camelCase and nested, unlike the flat snake_case rows the screen endpoints
 * return: these are documents a client stores verbatim, not rows a component
 * reads. Money is integer minor units with its currency alongside, as everywhere.
 * Nothing here is frozen - client and server ship from the
 * same origin - so do not bring Splitwise's decimal strings anywhere near it.
 */
import type { AvatarPattern } from "./avatar-pattern.ts";

/**
 * A person, as somebody else's device needs to render them.
 *
 * `email` is the login address for real accounts, and the invite address for
 * ghosts (`invite_email` on the row). Ghosts must not occupy `users.email`,
 * or inviting someone would block them from registering. `mergedIntoUserId`
 * travels so a client that missed the `user_merge` row still knows this row
 * is a retired stub rather than a living person with a mysteriously empty
 * history.
 */
export interface SyncUser {
  id: string;
  name: string;
  nickname: string | null;
  iconLetters: string | null;
  iconEmoji: string | null;
  iconHue: number | null;
  iconPattern: AvatarPattern | null;
  email: string | null;
  isGhost: boolean;
  defaultCurrency: string;
  mergedIntoUserId: string | null;
  deletedAt: string | null;
}

export interface SyncShare {
  userId: string;
  paidShareMinor: number;
  owedShareMinor: number;
  /** The raw number the user typed for this split type. Never used for a balance. */
  splitInput: number | null;
}

/**
 * One who-owes-whom edge, as stored in `expense_repayments`.
 *
 * A hint to `deriveRepayments`, not a second ledger. Net positions do not
 * determine the pairing (two payers, four people: several valid matchings).
 * Imported bills carry Splitwise's own pairing so a non-group expense does not
 * show up as a phantom friend balance when the client re-derives on read.
 */
export interface SyncRepayment {
  fromUserId: string;
  toUserId: string;
  amountMinor: number;
}

/**
 * An expense, its shares, and the people on it.
 *
 * `people` is here rather than left to a separate `users` sync because an
 * expense can arrive naming somebody the caller has never seen - added to a
 * group bill by a third party - and a row of blanks where a name should be is a
 * worse bug than a few duplicated user records. Names go stale until the next
 * shared write, which is accepted (docs/OFFLINE.md).
 *
 * `deletedAt` is carried, not filtered. A tombstone is how restore works.
 */
export interface SyncExpense {
  id: string;
  groupId: string | null;
  description: string;
  details: string | null;
  costMinor: number;
  currencyCode: string;
  date: string;
  categoryId: number | null;
  splitType: string;
  /** JSON string or null. Itemized line items; presentation detail, never ledger data. */
  splitMeta: string | null;
  isPayment: boolean;
  paymentMethod: string | null;
  repeatInterval: string | null;
  nextRepeat: string | null;
  repeatOf: string | null;
  /**
   * The interval a stopped series will resume with. Null while live or on a
   * one-off. Not a column: stored in `expenses.metadata.repeat_paused`.
   */
  repeatPaused: string | null;
  /**
   * A leftover-cent settle-up written during Splitwise import. Friend recency
   * skips these. Not a column: stored in `expenses.metadata.import_rounding`.
   */
  importRounding: boolean;
  /** What a later edit has to send back as `baseVersion`. */
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  shares: SyncShare[];
  people: SyncUser[];
  /**
   * Stored pairing, passed back into `deriveRepayments` as `preferred`.
   * Absent on a locally-created bill that has not been echoed yet; greedy
   * then matches what the server will store. Always present on bootstrap/pull.
   */
  repayments?: SyncRepayment[];
}

export interface SyncComment {
  id: string;
  expenseId: string;
  userId: string;
  /** 'user' or 'system'. Clients may only ever push the former. */
  kind: string;
  content: string;
  createdAt: string;
  deletedAt: string | null;
  author: SyncUser | null;
}

export interface SyncGroup {
  id: string;
  name: string;
  groupType: string;
  defaultCurrency: string;
  simplifyByDefault: boolean;
  createdBy: string | null;
  deletedAt: string | null;
}

export interface SyncGroupMember {
  groupId: string;
  userId: string;
  role: string;
  joinedVia: string;
  joinedAt: string;
  /** Set means they have left. The row stays; their history in the group does too. */
  leftAt: string | null;
  user: SyncUser | null;
}

export interface SyncFriendship {
  /** Canonical order, `userAId < userBId`, exactly as stored. */
  userAId: string;
  userBId: string;
  createdAt: string;
  /** Whichever of the pair is not the caller. Null if the row names them twice. */
  otherUser: SyncUser | null;
}

export interface SyncCurrency {
  code: string;
  decimalPlaces: number;
  symbol: string | null;
  name: string | null;
}

export interface SyncCategory {
  /** Splitwise's integer, not a ULID. See src/db/categories.ts. */
  id: number;
  parentId: number | null;
  name: string;
  icon: string | null;
  isDefault: boolean;
}
