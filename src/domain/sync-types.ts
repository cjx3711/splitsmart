/**
 * The wire shapes `/api/v1/sync/*` speaks.
 *
 * PURE TYPES, no imports, deliberately. This module is imported by BOTH sides —
 * src/routes/native/sync-serializers.ts builds these, and web/src/db/local.ts
 * stores them — for the same reason src/domain/split.ts is shared: one definition
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
 *
 * NOT the compat layer. Nothing here is frozen — client and server ship from the
 * same origin — so do not bring Splitwise's decimal strings anywhere near it.
 */
/**
 * A person, as somebody else's device needs to render them.
 *
 * `email` is included because the friends screen shows it and the invite flow
 * needs to know whether there is one. `mergedIntoUserId` travels so a client
 * that missed the `user_merge` row still knows this row is a retired stub rather
 * than a living person with a mysteriously empty history.
 */
export interface SyncUser {
  id: string;
  firstName: string;
  lastName: string | null;
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
 * An expense, its shares, and the people on it.
 *
 * `people` is here rather than left to a separate `users` sync because an
 * expense can arrive naming somebody the caller has never seen — added to a
 * group bill by a third party — and a row of blanks where a name should be is a
 * worse bug than a few duplicated user records. Names go stale until the next
 * shared write, which is accepted (docs/OFFLINE.md).
 *
 * `deletedAt` is carried, not filtered. A tombstone is how restore works, and
 * the compat layer returns them too.
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
  /** What a later edit has to send back as `baseVersion`. */
  version: number;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  shares: SyncShare[];
  people: SyncUser[];
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
  /** Splitwise's integer, not a ULID. See docs/SPLITWISE_COMPAT.md. */
  id: number;
  parentId: number | null;
  name: string;
  icon: string | null;
  isDefault: boolean;
}
