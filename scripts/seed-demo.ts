/**
 * Seed a demo account with sample friends, groups, and expenses.
 *
 * Idempotent: skips if the target user already has expenses.
 *
 * Usage:
 *   yarn seed:demo
 *   yarn seed:demo -- alice@example.com
 */
import { hashPassword } from "../src/auth/password.ts";
import { createExpense, createPayment, updateExpense } from "../src/domain/expenses.ts";
import { createComment } from "../src/domain/comments.ts";
import { runDueRecurrences } from "../src/domain/scheduler.ts";
import { addFriendship } from "../src/domain/friends.ts";
import { mintAccessLink } from "../src/domain/access-links.ts";
import type { GroupType } from "../src/domain/group-types.ts";
import { ulid } from "../src/domain/ulid.ts";
import { db, transaction } from "../src/db/index.ts";

const DEFAULT_EMAIL = "test@example.com";
const DEFAULT_PASSWORD = "password123";

/**
 * Dates relative to today, so the demo is never stale.
 *
 * The recurring series below depends on this: a template can only produce bills
 * once its `next_repeat` is in the past, and a hardcoded year would either
 * generate nothing or generate a decade of rent.
 */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

async function ensureUser(
  email: string,
  profile: {
    firstName: string;
    lastName?: string;
    defaultCurrency?: string;
    password?: string;
  },
): Promise<string> {
  const existing = await db
    .selectFrom("users")
    .select("id")
    .where("email", "=", email)
    .where("deleted_at", "is", null)
    .executeTakeFirst();

  if (existing) return existing.id;

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
    .returning("id")
    .executeTakeFirstOrThrow();

  return created.id;
}

async function createGhost(
  firstName: string,
  lastName: string,
  defaultCurrency = "USD",
): Promise<string> {
  const id = ulid();
  await db
    .insertInto("users")
    .values({
      id,
      first_name: firstName,
      last_name: lastName,
      default_currency: defaultCurrency,
      is_ghost: 1,
    })
    .execute();
  return id;
}

async function createGroup(
  ownerId: string,
  name: string,
  groupType: GroupType,
  defaultCurrency: string,
  memberIds: string[],
  simplifyByDefault = false,
): Promise<string> {
  const groupId = ulid();
  await db
    .insertInto("groups")
    .values({
      id: groupId,
      name,
      group_type: groupType,
      default_currency: defaultCurrency,
      simplify_by_default: simplifyByDefault ? 1 : 0,
      created_by: ownerId,
    })
    .execute();

  await db
    .insertInto("group_members")
    .values(
      memberIds.map((userId) => ({
        group_id: groupId,
        user_id: userId,
        role: userId === ownerId ? "owner" : "member",
        joined_via: userId === ownerId ? "creator" : "added",
      })),
    )
    .execute();

  return groupId;
}

async function main(): Promise<void> {
  const email = process.argv[2] ?? DEFAULT_EMAIL;

  const userId = await ensureUser(email, {
    firstName: "Test",
    lastName: "User",
    defaultCurrency: "USD",
  });

  const user = await db
    .selectFrom("users")
    .select("first_name")
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();

  const existing = await db
    .selectFrom("expenses")
    .innerJoin("expense_users", "expense_users.expense_id", "expenses.id")
    .select("expenses.id")
    .where("expense_users.user_id", "=", userId)
    .where("expenses.deleted_at", "is", null)
    .executeTakeFirst();

  if (existing) {
    console.log(`${email} already has expenses — skipping demo seed.`);
    return;
  }

  // Real accounts (can log in with password123). Created oldest-first so the
  // sidebar's ULID ordering surfaces the later names as "latest".
  const jamieId = await ensureUser("jamie@example.com", {
    firstName: "Jamie",
    lastName: "Lee",
  });
  const samId = await ensureUser("sam@example.com", {
    firstName: "Sam",
    lastName: "Rivera",
  });
  const taylorId = await ensureUser("taylor@example.com", {
    firstName: "Taylor",
    lastName: "Kim",
  });
  const morganId = await ensureUser("morgan@example.com", {
    firstName: "Morgan",
    lastName: "Chen",
  });
  const rileyId = await ensureUser("riley@example.com", {
    firstName: "Riley",
    lastName: "Brooks",
  });
  const caseyId = await ensureUser("casey@example.com", {
    firstName: "Casey",
    lastName: "Walsh",
  });
  const jordanId = await ensureUser("jordan@example.com", {
    firstName: "Jordan",
    lastName: "Lee",
  });

  // Guest placeholders (no login). Also oldest-first.
  const alexId = await createGhost("Alex", "Kim", "JPY");
  const quinnId = await createGhost("Quinn", "Miller");
  const reeseId = await createGhost("Reese", "Johnson");
  const parkerId = await createGhost("Parker", "Davis");
  const sageId = await createGhost("Sage", "Williams");
  const blakeId = await createGhost("Blake", "Hart");
  const drewId = await createGhost("Drew", "Nguyen");
  const averyId = await createGhost("Avery", "Patel");

  // Explicit friendships (removable in the UI).
  for (const friendId of [samId, morganId, rileyId, caseyId, jordanId, blakeId, drewId, averyId]) {
    await addFriendship(db, userId, friendId);
  }

  // Groups oldest-first so the sidebar shows the five newest names.
  const bookClubId = await createGroup(userId, "Book Club", "other", "USD", [
    userId,
    morganId,
    rileyId,
  ]);
  const lunchClubId = await createGroup(userId, "Office Lunch Club", "work", "USD", [
    userId,
    caseyId,
    jordanId,
    taylorId,
  ]);
  const apartmentId = await createGroup(
    userId,
    "Apartment 4B",
    "home",
    "USD",
    [userId, jamieId],
    true,
  );
  const gameNightId = await createGroup(userId, "Game Night Crew", "sports", "USD", [
    userId,
    quinnId,
    reeseId,
    parkerId,
  ]);
  const bbqId = await createGroup(userId, "Summer BBQ", "outing", "USD", [
    userId,
    sageId,
    samId,
  ]);
  const campingId = await createGroup(userId, "Yosemite Camping", "trip", "USD", [
    userId,
    drewId,
    averyId,
    blakeId,
  ]);
  const weddingId = await createGroup(userId, "Jess & Marco's Wedding", "event", "USD", [
    userId,
    morganId,
    rileyId,
    caseyId,
    jordanId,
  ]);
  const hackathonId = await createGroup(userId, "Hackathon Squad", "project", "USD", [
    userId,
    taylorId,
    parkerId,
    sageId,
  ]);
  const skiTripId = await createGroup(userId, "Ski Trip 2026", "trip", "USD", [
    userId,
    jamieId,
    samId,
  ]);
  const tokyoId = await createGroup(userId, "Weekend in Tokyo", "trip", "JPY", [
    userId,
    jamieId,
    samId,
    alexId,
  ]);

  // Tokyo trip
  const ramenId = await createExpense({
    groupId: tokyoId,
    description: "Ramen at Ichiran",
    costMinor: 4800,
    currencyCode: "JPY",
    date: "2026-08-10",
    categoryId: 13,
    splitType: "equal",
    createdBy: userId,
    participants: [
      { userId, paidMinor: 4800 },
      { userId: jamieId, paidMinor: 0 },
      { userId: samId, paidMinor: 0 },
      { userId: alexId, paidMinor: 0 },
    ],
  });
  await createExpense({
    groupId: tokyoId,
    description: "TeamLab tickets",
    costMinor: 9600,
    currencyCode: "JPY",
    date: "2026-08-11",
    categoryId: 40,
    splitType: "equal",
    createdBy: jamieId,
    participants: [
      { userId, paidMinor: 0 },
      { userId: jamieId, paidMinor: 9600 },
      { userId: samId, paidMinor: 0 },
      { userId: alexId, paidMinor: 0 },
    ],
  });

  // Apartment
  const groceriesId = await createExpense({
    groupId: apartmentId,
    description: "Trader Joe's run",
    costMinor: 8743,
    currencyCode: "USD",
    date: "2026-08-05",
    categoryId: 12,
    splitType: "equal",
    createdBy: userId,
    participants: [
      { userId, paidMinor: 8743 },
      { userId: jamieId, paidMinor: 0 },
    ],
  });
  await createPayment({
    fromUserId: userId,
    toUserId: jamieId,
    amountMinor: 5000,
    currencyCode: "USD",
    groupId: apartmentId,
    date: "2026-08-15",
    paymentMethod: "Venmo",
    createdBy: userId,
  });

  // Ski trip
  await createExpense({
    groupId: skiTripId,
    description: "Lift tickets",
    costMinor: 42000,
    currencyCode: "USD",
    date: "2026-02-14",
    categoryId: 40,
    splitType: "equal",
    createdBy: userId,
    participants: [
      { userId, paidMinor: 42000 },
      { userId: jamieId, paidMinor: 0 },
      { userId: samId, paidMinor: 0 },
    ],
  });

  // Wedding
  await createExpense({
    groupId: weddingId,
    description: "Hotel block deposit",
    costMinor: 32500,
    currencyCode: "USD",
    date: "2026-06-01",
    categoryId: 47,
    splitType: "equal",
    createdBy: morganId,
    participants: [
      { userId, paidMinor: 0 },
      { userId: morganId, paidMinor: 32500 },
      { userId: rileyId, paidMinor: 0 },
      { userId: caseyId, paidMinor: 0 },
      { userId: jordanId, paidMinor: 0 },
    ],
  });

  // Lunch club
  const sushiId = await createExpense({
    groupId: lunchClubId,
    description: "Team sushi lunch",
    costMinor: 15640,
    currencyCode: "USD",
    date: "2026-07-22",
    categoryId: 13,
    splitType: "equal",
    createdBy: caseyId,
    participants: [
      { userId, paidMinor: 0 },
      { userId: caseyId, paidMinor: 15640 },
      { userId: jordanId, paidMinor: 0 },
      { userId: taylorId, paidMinor: 0 },
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
    createdBy: userId,
    participants: [
      { userId, paidMinor: 1850 },
      { userId: samId, paidMinor: 0 },
    ],
  });

  // One-on-one with a guest explicit friend
  await createExpense({
    groupId: null,
    description: "Concert tickets",
    costMinor: 12000,
    currencyCode: "USD",
    date: "2026-08-02",
    categoryId: 40,
    splitType: "equal",
    createdBy: userId,
    participants: [
      { userId, paidMinor: 12000 },
      { userId: blakeId, paidMinor: 0 },
    ],
  });

  // --- recurring series ----------------------------------------------------
  //
  // Two templates, dated far enough back that the scheduler has bills to make,
  // and then the REAL job is run rather than inserting occurrences by hand: the
  // demo should show what the app actually produces, including the cap of one
  // occurrence per template per tick.
  const rentTemplateId = await createExpense({
    groupId: apartmentId,
    description: "Rent",
    costMinor: 180_000,
    currencyCode: "USD",
    date: daysAgo(100),
    categoryId: 3,
    splitType: "equal",
    repeatInterval: "monthly",
    createdBy: userId,
    participants: [
      { userId, paidMinor: 180_000 },
      { userId: jamieId, paidMinor: 0 },
    ],
  });

  const coffeeTemplateId = await createExpense({
    groupId: lunchClubId,
    description: "Friday coffee round",
    costMinor: 2400,
    currencyCode: "USD",
    date: daysAgo(30),
    categoryId: 13,
    splitType: "equal",
    repeatInterval: "weekly",
    createdBy: caseyId,
    participants: [
      { userId, paidMinor: 0 },
      { userId: caseyId, paidMinor: 2400 },
      { userId: jordanId, paidMinor: 0 },
    ],
  });

  // Two ticks: enough for a couple of real bills, and it deliberately leaves
  // both series a little behind, which is a state the expense page has to
  // explain rather than hide.
  const firstTick = await runDueRecurrences();
  const secondTick = await runDueRecurrences();
  const generated = firstTick.generated.length + secondTick.generated.length;

  // --- comments ------------------------------------------------------------
  //
  // User comments are written through the domain writer, the same path the UI
  // uses. The SYSTEM ones below are not written here at all: they come out of a
  // real edit, which is the only way they are ever created.
  await createComment({
    expenseId: ramenId,
    userId: jamieId,
    content: "Worth the queue. I'll get the next one.",
    createdAt: `${daysAgo(7)}T09:12:00Z`,
  });
  await createComment({
    expenseId: ramenId,
    userId,
    content: "Extra chashu was my fault, sorry.",
    createdAt: `${daysAgo(7)}T09:20:00Z`,
  });
  await createComment({
    expenseId: sushiId,
    userId: jordanId,
    content: "Taylor wasn't there for the second round — should we split that separately?",
    createdAt: `${daysAgo(20)}T12:40:00Z`,
  });
  await createComment({
    expenseId: groceriesId,
    userId: jamieId,
    content: "Did this include the laundry stuff?",
    createdAt: `${daysAgo(12)}T18:05:00Z`,
  });

  // An edit, so the thread on this bill also carries the generated note
  // describing what changed. Same writer the Edit dialog uses.
  await updateExpense(groceriesId, {
    groupId: apartmentId,
    description: "Trader Joe's run",
    details: "Includes the laundry detergent",
    costMinor: 9_243,
    currencyCode: "USD",
    date: "2026-08-05",
    categoryId: 12,
    splitType: "equal",
    participants: [
      { userId, paidMinor: 9_243 },
      { userId: jamieId, paidMinor: 0 },
    ],
    updatedBy: userId,
  });

  const groupLink = await transaction((trx) =>
    mintAccessLink(trx, { kind: "group", groupId: tokyoId, createdBy: userId }),
  );
  const friendLink = await transaction((trx) =>
    mintAccessLink(trx, { kind: "friend", userId: alexId, createdBy: userId }),
  );

  console.log(`Seeded demo data for ${email} (${user.first_name}):`);
  console.log(`  Login:    ${email} / ${DEFAULT_PASSWORD}`);
  console.log("  Friends:  15 (7 real accounts, 8 guest placeholders)");
  console.log("  Groups:   10 (sidebar shows the 5 newest)");
  console.log("  Expenses: 8 expenses + 1 payment across USD and JPY");
  console.log(
    `  Repeats:  2 series (monthly rent, weekly coffee) with ${generated} generated bill(s)`,
  );
  console.log("            both left slightly behind on purpose, so the catch-up note shows");
  console.log("  Comments: 4 typed + 1 generated by an edit (see Trader Joe's run)");
  console.log("  Guest links:");
  console.log(`    group  ${groupLink.url}`);
  console.log(`    friend ${friendLink.url}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
