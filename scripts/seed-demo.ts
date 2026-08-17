/**
 * Seed a demo account with sample friends, groups, and expenses.
 *
 * Idempotent: skips if the target user already has expenses.
 *
 * Usage:
 *   yarn seed:demo
 *   yarn seed:demo -- alice@example.com
 */
import { generateToken, hashPassword } from "../src/auth/password.ts";
import { createExpense, createPayment } from "../src/domain/expenses.ts";
import { addFriendship } from "../src/domain/friends.ts";
import { ulid } from "../src/domain/ulid.ts";
import { db } from "../src/db/index.ts";
import { env } from "../src/env.ts";

const DEFAULT_EMAIL = "test@example.com";
const DEFAULT_PASSWORD = "password123";

async function ensureUser(
  email: string,
  profile: {
    firstName: string;
    lastName?: string;
    defaultCurrency?: string;
    password?: string;
  },
): Promise<{ id: string; first_name: string }> {
  const existing = await db
    .selectFrom("users")
    .select(["id", "first_name"])
    .where("email", "=", email)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  if (existing) return existing;

  const created = await db
    .insertInto("users")
    .values({
      id: ulid(),
      email,
      password_hash: await hashPassword(profile.password ?? DEFAULT_PASSWORD),
      first_name: profile.firstName,
      last_name: profile.lastName ?? null,
      default_currency: profile.defaultCurrency ?? "USD",
      is_ghost: 0,
      email_verified_at: new Date().toISOString(),
    })
    .returning(["id", "first_name"])
    .executeTakeFirstOrThrow();

  return created;
}

async function main(): Promise<void> {
  const email = process.argv[2] ?? DEFAULT_EMAIL;

  const user = await ensureUser(email, {
    firstName: "Test",
    lastName: "User",
    defaultCurrency: "USD",
  });

  const existing = await db
    .selectFrom("expenses")
    .innerJoin("expense_users", "expense_users.expense_id", "expenses.id")
    .select("expenses.id")
    .where("expense_users.user_id", "=", user.id)
    .where("expenses.deleted_at", "is", null)
    .executeTakeFirst();

  if (existing) {
    console.log(`${email} already has expenses — skipping demo seed.`);
    return;
  }

  const jamie = await ensureUser("jamie@example.com", {
    firstName: "Jamie",
    lastName: "Lee",
    defaultCurrency: "USD",
  });
  const jamieId = jamie.id;

  const sam = await ensureUser("sam@example.com", {
    firstName: "Sam",
    lastName: "Rivera",
    defaultCurrency: "USD",
  });
  const samId = sam.id;

  const alexId = ulid();
  await db
    .insertInto("users")
    .values({
      id: alexId,
      first_name: "Alex",
      last_name: "Kim",
      default_currency: "JPY",
      is_ghost: 1,
    })
    .execute();

  await addFriendship(db, user.id, samId);

  const tripGroupId = ulid();
  const apartmentGroupId = ulid();

  await db
    .insertInto("groups")
    .values([
      {
        id: tripGroupId,
        name: "Weekend in Tokyo",
        group_type: "trip",
        default_currency: "JPY",
        simplify_by_default: 0,
        invite_token: generateToken(24),
        created_by: user.id,
      },
      {
        id: apartmentGroupId,
        name: "Apartment 4B",
        group_type: "home",
        default_currency: "USD",
        simplify_by_default: 1,
        invite_token: generateToken(24),
        created_by: user.id,
      },
    ])
    .execute();

  await db
    .insertInto("group_members")
    .values([
      { group_id: tripGroupId, user_id: user.id, role: "owner", joined_via: "creator" },
      { group_id: tripGroupId, user_id: jamieId, role: "member", joined_via: "invite_link" },
      { group_id: tripGroupId, user_id: samId, role: "member", joined_via: "invite_link" },
      { group_id: tripGroupId, user_id: alexId, role: "member", joined_via: "invite_link" },
      { group_id: apartmentGroupId, user_id: user.id, role: "owner", joined_via: "creator" },
      { group_id: apartmentGroupId, user_id: jamieId, role: "member", joined_via: "invite_link" },
    ])
    .execute();

  // Trip expenses (JPY) — category 13 = Dining out, 32 = Taxi
  await createExpense({
    groupId: tripGroupId,
    description: "Ramen at Ichiran",
    costMinor: 4800,
    currencyCode: "JPY",
    date: "2026-08-10",
    categoryId: 13,
    splitType: "equal",
    createdBy: user.id,
    participants: [
      { userId: user.id, paidMinor: 4800 },
      { userId: jamieId, paidMinor: 0 },
      { userId: samId, paidMinor: 0 },
      { userId: alexId, paidMinor: 0 },
    ],
  });

  await createExpense({
    groupId: tripGroupId,
    description: "TeamLab tickets",
    costMinor: 9600,
    currencyCode: "JPY",
    date: "2026-08-11",
    categoryId: 40,
    splitType: "equal",
    createdBy: jamieId,
    participants: [
      { userId: user.id, paidMinor: 0 },
      { userId: jamieId, paidMinor: 9600 },
      { userId: samId, paidMinor: 0 },
      { userId: alexId, paidMinor: 0 },
    ],
  });

  await createExpense({
    groupId: tripGroupId,
    description: "Taxi to Shibuya",
    costMinor: 3200,
    currencyCode: "JPY",
    date: "2026-08-11",
    categoryId: 32,
    splitType: "equal",
    createdBy: samId,
    participants: [
      { userId: user.id, paidMinor: 0 },
      { userId: jamieId, paidMinor: 0 },
      { userId: samId, paidMinor: 3200 },
      { userId: alexId, paidMinor: 0 },
    ],
  });

  // Apartment groceries — category 12 = Groceries
  await createExpense({
    groupId: apartmentGroupId,
    description: "Trader Joe's run",
    costMinor: 8743,
    currencyCode: "USD",
    date: "2026-08-05",
    categoryId: 12,
    splitType: "equal",
    createdBy: user.id,
    participants: [
      { userId: user.id, paidMinor: 8743 },
      { userId: jamieId, paidMinor: 0 },
    ],
  });

  await createExpense({
    groupId: apartmentGroupId,
    description: "Electric bill — August",
    costMinor: 14250,
    currencyCode: "USD",
    date: "2026-08-01",
    categoryId: 36,
    splitType: "equal",
    createdBy: jamieId,
    participants: [
      { userId: user.id, paidMinor: 0 },
      { userId: jamieId, paidMinor: 14250 },
    ],
  });

  // Non-group expense with an explicit friend
  await createExpense({
    groupId: null,
    description: "Coffee catch-up",
    costMinor: 1850,
    currencyCode: "USD",
    date: "2026-08-14",
    categoryId: 13,
    splitType: "equal",
    createdBy: user.id,
    participants: [
      { userId: user.id, paidMinor: 1850 },
      { userId: samId, paidMinor: 0 },
    ],
  });

  // Partial settlement between roommates
  await createPayment({
    fromUserId: user.id,
    toUserId: jamieId,
    amountMinor: 5000,
    currencyCode: "USD",
    groupId: apartmentGroupId,
    date: "2026-08-15",
    paymentMethod: "Venmo",
    createdBy: user.id,
  });

  console.log(`Seeded demo data for ${email} (${user.first_name}):`);
  console.log(`  Login:    ${email} / ${DEFAULT_PASSWORD}`);
  console.log("  Friends:  Sam Rivera (real, explicit), Jamie Lee (real, via groups), Alex Kim (guest)");
  console.log("  Groups:   Weekend in Tokyo (4 people), Apartment 4B (2 people)");
  console.log("  Expenses: 6 expenses + 1 payment across USD and JPY");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
