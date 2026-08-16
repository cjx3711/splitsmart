/**
 * Kysely database types.
 *
 * These MUST match migrations/*.sql. They are checked in so the repo typechecks
 * without a database present, but they are not hand-maintained in the long run:
 * after adding a migration, run
 *
 *   npm run db:migrate && npm run db:codegen
 *
 * which regenerates this file from the real schema. If you edit it by hand and
 * forget the migration, you get types that lie — which is worse than no types.
 */
import type { Generated, Insertable, Selectable, Updateable } from "kysely";

export interface CurrenciesTable {
  code: string;
  decimal_places: Generated<number>;
  symbol: string | null;
  name: string | null;
}

export interface UsersTable {
  id: Generated<number>;
  splitwise_id: number | null;
  email: string | null;
  password_hash: string | null;
  email_verified_at: string | null;
  first_name: string;
  last_name: string | null;
  avatar_url: string | null;
  default_currency: Generated<string>;
  is_ghost: Generated<number>;
  recovery_code_hash: string | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  deleted_at: string | null;
}

export interface SessionsTable {
  id: string;
  token_hash: string;
  user_id: number;
  user_agent: string | null;
  created_at: Generated<string>;
  last_seen_at: Generated<string>;
  expires_at: string;
}

export interface ApiTokensTable {
  id: string;
  token_hash: string;
  user_id: number;
  name: string;
  last_used_at: string | null;
  created_at: Generated<string>;
  expires_at: string | null;
  revoked_at: string | null;
}

export interface GroupsTable {
  id: Generated<number>;
  splitwise_id: number | null;
  name: string;
  group_type: Generated<string>;
  default_currency: Generated<string>;
  avatar_url: string | null;
  simplify_by_default: Generated<number>;
  invite_token: string | null;
  invite_rotated_at: string | null;
  created_by: number | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  deleted_at: string | null;
}

export interface GroupMembersTable {
  group_id: number;
  user_id: number;
  role: Generated<string>;
  joined_via: Generated<string>;
  joined_at: Generated<string>;
  left_at: string | null;
}

export interface FriendshipsTable {
  user_a_id: number;
  user_b_id: number;
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
  id: Generated<number>;
  splitwise_id: number | null;
  group_id: number | null;
  description: string;
  details: string | null;
  cost_minor: number;
  currency_code: string;
  date: string;
  category_id: number | null;
  split_type: Generated<string>;
  is_payment: Generated<number>;
  payment_method: string | null;
  created_by: number | null;
  updated_by: number | null;
  created_at: Generated<string>;
  updated_at: Generated<string>;
  deleted_at: string | null;
}

export interface ExpenseUsersTable {
  expense_id: number;
  user_id: number;
  paid_share_minor: Generated<number>;
  owed_share_minor: Generated<number>;
  split_input: number | null;
}

export interface ExpenseRepaymentsTable {
  expense_id: number;
  seq: number;
  from_user_id: number;
  to_user_id: number;
  amount_minor: number;
}

export interface CommentsTable {
  id: Generated<number>;
  splitwise_id: number | null;
  expense_id: number;
  user_id: number;
  content: string;
  created_at: Generated<string>;
  deleted_at: string | null;
}

export interface ActivityTable {
  id: Generated<number>;
  user_id: number | null;
  group_id: number | null;
  expense_id: number | null;
  action: string;
  payload: string | null;
  created_at: Generated<string>;
}

export interface Database {
  currencies: CurrenciesTable;
  users: UsersTable;
  sessions: SessionsTable;
  api_tokens: ApiTokensTable;
  groups: GroupsTable;
  group_members: GroupMembersTable;
  friendships: FriendshipsTable;
  categories: CategoriesTable;
  expenses: ExpensesTable;
  expense_users: ExpenseUsersTable;
  expense_repayments: ExpenseRepaymentsTable;
  comments: CommentsTable;
  activity: ActivityTable;
}

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export type Group = Selectable<GroupsTable>;
export type NewGroup = Insertable<GroupsTable>;

export type Expense = Selectable<ExpensesTable>;
export type NewExpense = Insertable<ExpensesTable>;

export type ExpenseUser = Selectable<ExpenseUsersTable>;
export type Category = Selectable<CategoriesTable>;
export type Currency = Selectable<CurrenciesTable>;
