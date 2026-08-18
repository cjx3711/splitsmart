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
 *
 * SEED_TODAY pins that "today" to a fixed date. The pixel snapshots
 * (docs/AI_SMOKE_TESTS.md) need it: a baseline PNG recorded in March and
 * compared in August differs in every rendered date, which is churn, not a
 * regression. Pinning does NOT make the series stop being behind — dueness is
 * still judged against the real clock — so the catch-up state the demo exists
 * to show is intact, and the scheduler's one-per-tick cap keeps the number of
 * generated bills the same however long ago the anchor was.
 */
const SEED_NOW = process.env.SEED_TODAY
  ? Date.parse(`${process.env.SEED_TODAY}T12:00:00Z`)
  : Date.now();

if (Number.isNaN(SEED_NOW)) {
  console.error(`SEED_TODAY must be YYYY-MM-DD, got: ${process.env.SEED_TODAY}`);
  process.exit(1);
}

/**
 * ULIDs encode a millisecond timestamp. Creating a dozen groups in the same
 * millisecond makes their sort order random, and the sidebar shows the five
 * newest — so a smoke snapshot would shuffle every reset. Tick the clock once
 * per id so oldest-first insertion is also oldest-first in ULID order.
 */
let seedClock = SEED_NOW;
function seedUlid(): string {
  seedClock += 1;
  return ulid(seedClock);
}

function daysAgo(days: number): string {
  return new Date(SEED_NOW - days * 86_400_000).toISOString().slice(0, 10);
}

async function ensureUser(
  email: string,
  profile: {
    name: string;
    nickname?: string | null;
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
      id: seedUlid(),
      email,
      password_hash: await hashPassword(profile.password ?? DEFAULT_PASSWORD),
      name: profile.name,
      nickname: profile.nickname?.trim() || null,
      default_currency: profile.defaultCurrency ?? "USD",
      is_ghost: 0,
      email_verified_at: new Date().toISOString(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return created.id;
}

async function createGhost(
  name: string,
  nickname: string | null,
  defaultCurrency = "USD",
): Promise<string> {
  const id = seedUlid();
  await db
    .insertInto("users")
    .values({
      id,
      name,
      nickname,
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
  const groupId = seedUlid();
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
    name: "Test User",
    defaultCurrency: "USD",
  });

  const user = await db
    .selectFrom("users")
    .select("name")
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
  const jjId = await ensureUser("jj@example.com", {
    name: "Lee Jin Jie",
    nickname: "JJ",
  });
  const ahBengId = await ensureUser("ahbeng@example.com", {
    name: "Tan Ah Beng",
    nickname: "Ah Beng",
  });
  const taroId = await ensureUser("taro@example.com", {
    name: "Tanaka Taro",
    nickname: "Taro",
  });
  const jasId = await ensureUser("jas@example.com", {
    name: "Jasmine Lim Jia Hui",
    nickname: "Jas",
  });
  const danialId = await ensureUser("danial@example.com", {
    name: "Muhammad Danial",
    nickname: "Danial",
  });
  const melId = await ensureUser("mel@example.com", {
    name: "Melvin Tan Wei Ming",
    nickname: "Mel",
  });
  const aisyahId = await ensureUser("aisyah@example.com", {
    name: "Nur Aisyah",
    nickname: "Aisyah",
  });

  // Guest placeholders (no login). Also oldest-first.
  const hanaId = await createGhost("Yamada Hanako", "Hana", "JPY");
  const gerryId = await createGhost("Gerald Teo Jia Hao", "Gerry");
  const priyaId = await createGhost("Priya Nair", "Priya");
  const yukiId = await createGhost("Sato Yuki", "Yuki");
  const ahLianId = await createGhost("Tan Ah Lian", "Ah Lian");
  const johnId = await createGhost("John Smith", "John");
  const jenId = await createGhost("Jennifer Johnson", "Jen");
  const jamesId = await createGhost("James Smith", "James");

  // Explicit friendships (removable in the UI).
  for (const friendId of [ahBengId, jasId, danialId, melId, aisyahId, johnId, jenId, jamesId]) {
    await addFriendship(userId, friendId);
  }

  // Groups oldest-first so the sidebar shows the five newest names.
  const bookClubId = await createGroup(userId, "Book Club", "other", "USD", [
    userId,
    jasId,
    danialId,
  ]);
  const lunchClubId = await createGroup(userId, "Office Lunch Club", "work", "USD", [
    userId,
    melId,
    aisyahId,
    taroId,
  ]);
  const apartmentId = await createGroup(
    userId,
    "Apartment 4B",
    "home",
    "USD",
    [userId, jjId],
    true,
  );
  const gameNightId = await createGroup(userId, "Game Night Crew", "sports", "USD", [
    userId,
    gerryId,
    priyaId,
    yukiId,
  ]);
  const bbqId = await createGroup(userId, "Summer BBQ", "outing", "USD", [
    userId,
    ahLianId,
    ahBengId,
  ]);
  const campingId = await createGroup(userId, "Yosemite Camping", "trip", "USD", [
    userId,
    jenId,
    jamesId,
    johnId,
  ]);
  const weddingId = await createGroup(userId, "Jess & Marco's Wedding", "event", "USD", [
    userId,
    jasId,
    danialId,
    melId,
    aisyahId,
  ]);
  const hackathonId = await createGroup(userId, "Hackathon Squad", "project", "USD", [
    userId,
    taroId,
    yukiId,
    ahLianId,
  ]);
  const skiTripId = await createGroup(userId, "Ski Trip 2026", "trip", "USD", [
    userId,
    jjId,
    ahBengId,
  ]);
  const tokyoId = await createGroup(userId, "Weekend in Tokyo", "trip", "JPY", [
    userId,
    jjId,
    ahBengId,
    hanaId,
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
      { userId: jjId, paidMinor: 0 },
      { userId: ahBengId, paidMinor: 0 },
      { userId: hanaId, paidMinor: 0 },
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
    createdBy: jjId,
    participants: [
      { userId, paidMinor: 0 },
      { userId: jjId, paidMinor: 9600 },
      { userId: ahBengId, paidMinor: 0 },
      { userId: hanaId, paidMinor: 0 },
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
      { userId: jjId, paidMinor: 0 },
    ],
  });
  await createPayment({
    fromUserId: userId,
    toUserId: jjId,
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
      { userId: jjId, paidMinor: 0 },
      { userId: ahBengId, paidMinor: 0 },
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
    createdBy: jasId,
    participants: [
      { userId, paidMinor: 0 },
      { userId: jasId, paidMinor: 32500 },
      { userId: danialId, paidMinor: 0 },
      { userId: melId, paidMinor: 0 },
      { userId: aisyahId, paidMinor: 0 },
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
    createdBy: melId,
    participants: [
      { userId, paidMinor: 0 },
      { userId: melId, paidMinor: 15640 },
      { userId: aisyahId, paidMinor: 0 },
      { userId: taroId, paidMinor: 0 },
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
      { userId: ahBengId, paidMinor: 0 },
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
      { userId: johnId, paidMinor: 0 },
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
      { userId: jjId, paidMinor: 0 },
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
    createdBy: melId,
    participants: [
      { userId, paidMinor: 0 },
      { userId: melId, paidMinor: 2400 },
      { userId: aisyahId, paidMinor: 0 },
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
    userId: jjId,
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
    userId: aisyahId,
    content: "Taro wasn't there for the second round — should we split that separately?",
    createdAt: `${daysAgo(20)}T12:40:00Z`,
  });
  await createComment({
    expenseId: groceriesId,
    userId: jjId,
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
      { userId: jjId, paidMinor: 0 },
    ],
    updatedBy: userId,
  });

  const groupLink = await transaction((trx) =>
    mintAccessLink(trx, { kind: "group", groupId: tokyoId, createdBy: userId }),
  );
  const friendLink = await transaction((trx) =>
    mintAccessLink(trx, { kind: "friend", userId: hanaId, createdBy: userId }),
  );

  console.log(`Seeded demo data for ${email} (${user.name}):`);
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
