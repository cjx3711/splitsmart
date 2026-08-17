/**
 * Kysely database types.
 *
 * These MUST match migrations/*.sql. They are checked in so the repo typechecks
 * without a database present, but they are not hand-maintained in the long run:
 * after adding a migration, run
 *
 *   yarn db:migrate && yarn db:codegen
 *
 * which regenerates this file from the real schema. If you edit it by hand and
 * forget the migration, you get types that lie, which is worse than no types.
 *
 * Entity primary keys (`users`, `groups`, `expenses`, `comments`, `activity`)
 * are ULIDs (string), including on the Splitwise compat wire. Categories stay
 * integer because those ids are Splitwise's. Import matching keys live in
 * `metadata.splitwise_id`. See docs/ULIDS.md.
 */
import type { Generated, Insertable, Selectable, Updateable } from "kysely";

export interface CurrenciesTable {
  code: string;
  decimal_places: Generated<number>;
  symbol: string | null;
  name: string | null;
}

export interface UsersTable {
  id: string;
  /** JSON object. See src/domain/metadata.ts. */
  metadata: Generated<string>;
  email: string | null;
  password_hash: string | null;
  email_verified_at: string | null;
  first_name: string;
  last_name: string | null;
  avatar_url: string | null;
  default_currency: Generated<string>;
  is_ghost: Generated<number>;
  /** Tombstone left by a claim. Non-null implies deleted_at. See src/domain/merge.ts. */
  merged_into_user_id: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  deleted_at: string | null;
}

export interface SessionsTable {
  id: string;
  token_hash: string;
  user_id: string;
  user_agent: string | null;
  created_at: Generated<string>;
  last_seen_at: Generated<string>;
  expires_at: string;
}

export interface ApiTokensTable {
  id: string;
  token_hash: string;
  user_id: string;
  name: string;
  last_used_at: string | null;
  created_at: Generated<string>;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface AccessLinksTable {
  id: string;
  token_hash: string;
  /** Plaintext secret for owner copy. Guest auth uses token_hash. */
  token_secret: string | null;
  /** 'group' | 'group_member' | 'friend'. See src/domain/access-links.ts. */
  kind: string;
  group_id: string | null;
  /** The ghost this link acts as. NULL only for kind = 'group'. */
  user_id: string | null;
  created_by: string;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: Generated<string>;
  last_used_at: string | null;
}

export interface GroupsTable {
  id: string;
  /** JSON object. See src/domain/metadata.ts. */
  metadata: Generated<string>;
  name: string;
  group_type: Generated<string>;
  default_currency: Generated<string>;
  avatar_url: string | null;
  simplify_by_default: Generated<number>;
  created_by: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  deleted_at: string | null;
}

export interface GroupMembersTable {
  group_id: string;
  user_id: string;
  role: Generated<string>;
  joined_via: Generated<string>;
  joined_at: Generated<string>;
  left_at: string | null;
}

export interface FriendshipsTable {
  user_a_id: string;
  user_b_id: string;
  created_at: Generated<string>;
}

export interface CategoriesTable {
  id: Generated<number>;
  splitwise_id: number | null;
  parent_id: number | null;
  name: string;
  icon: string | null;
  sort_order: Generated<number>;
  is_default: Generated<number>;
}

export interface ExpensesTable {
  id: string;
  /** JSON object. See src/domain/metadata.ts. */
  metadata: Generated<string>;
  group_id: string | null;
  description: string;
  details: string | null;
  cost_minor: number;
  currency_code: string;
  date: string;
  category_id: number | null;
  split_type: Generated<string>;
  /** JSON blob, or NULL. Line items for an itemized split. See migrations/001_initial_schema.sql. */
  split_meta: string | null;
  is_payment: Generated<number>;
  payment_method: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  deleted_at: string | null;
}

export interface ExpenseUsersTable {
  expense_id: string;
  user_id: string;
  paid_share_minor: Generated<number>;
  owed_share_minor: Generated<number>;
  split_input: number | null;
}

export interface ExpenseRepaymentsTable {
  expense_id: string;
  seq: number;
  from_user_id: string;
  to_user_id: string;
  amount_minor: number;
}

export interface CommentsTable {
  id: string;
  /** JSON object. See src/domain/metadata.ts. */
  metadata: Generated<string>;
  expense_id: string;
  user_id: string;
  content: string;
  created_at: Generated<string>;
  deleted_at: string | null;
}

export interface EmailTokensTable {
  id: string;
  token_hash: string;
  user_id: string;
  purpose: string;
  /** Snapshot of the address at issue time. See migrations/001_initial_schema.sql. */
  email: string;
  created_at: Generated<string>;
  expires_at: string;
  used_at: string | null;
}

export interface ActivityTable {
  id: string;
  user_id: string | null;
  group_id: string | null;
  expense_id: string | null;
  action: string;
  payload: string | null;
  created_at: Generated<string>;
}

export interface Database {
  currencies: CurrenciesTable;
  users: UsersTable;
  sessions: SessionsTable;
  api_tokens: ApiTokensTable;
  access_links: AccessLinksTable;
  groups: GroupsTable;
  group_members: GroupMembersTable;
  friendships: FriendshipsTable;
  categories: CategoriesTable;
  expenses: ExpensesTable;
  expense_users: ExpenseUsersTable;
  expense_repayments: ExpenseRepaymentsTable;
  comments: CommentsTable;
  activity: ActivityTable;
  email_tokens: EmailTokensTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export type Group = Selectable<GroupsTable>;
export type NewGroup = Insertable<GroupsTable>;

export type Expense = Selectable<ExpensesTable>;
export type NewExpense = Insertable<ExpensesTable>;

export type AccessLink = Selectable<AccessLinksTable>;

export type ExpenseUser = Selectable<ExpenseUsersTable>;
export type Category = Selectable<CategoriesTable>;
export type Currency = Selectable<CurrenciesTable>;
