/**
 * Splitwise import.
 *
 * Pulls a Splitwise account into SplitSmart, in the order the data depends on
 * itself: people, then groups, then expenses. Each step is a separate call that
 * can be run on its own and re-run safely, which is what makes the whole thing
 * drivable from a wizard — or from a test — one HTTP request at a time.
 *
 * FOUR RULES THIS MODULE LIVES BY:
 *
 * 1. IDENTITY IS `splitwise_id` FIRST, EMAIL SECOND. Every row we create carries
 *    the Splitwise id it came from, so a second run matches instead of
 *    duplicating. Only when there is no id match do we fall back to matching an
 *    existing local account by email — that is the one heuristic in here, and
 *    the UI has to say so out loud before the user starts.
 *
 * 2. NOTHING IS WRITTEN TWICE. Groups and expenses are looked up by
 *    `splitwise_id` before insert. Re-running a step is a no-op plus a report.
 *
 * 3. EXPENSES GO THROUGH `createExpense`. No exceptions — see CLAUDE.md rule 3.
 *    Splitwise's own per-person `owed_share` values are imported as an `exact`
 *    split so the allocation is preserved byte for byte rather than re-derived
 *    (re-deriving would move cents, and therefore balances).
 *
 * 4. A BAD ROW IS SKIPPED, NEVER FUDGED. Unknown currency, a group that has not
 *    been imported yet, shares that do not add up — each of those returns a
 *    skip with a reason instead of a guess. A partial import you can see is
 *    worth more than a complete one you cannot trust.
 *
 * The API key never reaches this module as anything but a live client object,
 * and is never persisted. See src/splitwise/client.ts.
 */
import { db } from "../db/index.ts";
import { generateRecoveryCode, normaliseRecoveryCode, hashPassword } from "../auth/password.ts";
import { parseAmount } from "./money.ts";
import { createExpense } from "./expenses.ts";
import { addFriendship, listRelatedUserIds } from "./friends.ts";
import type {
  SplitwiseClient,
  SplitwiseExpense,
  SplitwiseGroup,
  SplitwiseUser,
} from "../splitwise/client.ts";

/** Splitwise's pseudo-group for expenses that belong to no group. */
const NON_GROUP_ID = 0;

export interface PersonResult {
  splitwiseId: number;
  localUserId: number;
  name: string;
  email: string | null;
  /** How this person was resolved — the UI shows the email matches explicitly. */
  matchedBy: "splitwise_id" | "email" | "self" | "created";
  /**
   * Only for freshly created placeholders, and only once: it is the sole way
   * that person can ever claim the account. Same contract as POST /friends.
   */
  recoveryCode?: string;
}

export interface SkippedRow {
  splitwiseId: number;
  description: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * Resolves Splitwise people to local users, creating placeholders as needed.
 *
 * Held across a whole step so a person appearing in six groups is looked up
 * once. Not shared between requests — each import call builds a fresh one, and
 * the database is the only durable state.
 */
export class PersonResolver {
  private readonly cache = new Map<number, PersonResult>();

  // Assigned in the body rather than declared as constructor parameter
  // properties: `--experimental-strip-types` rejects those outright
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), and there is no build step in dev.
  /** The local account doing the import. */
  private readonly ownerId: number;
  /** Their Splitwise id, so their own rows resolve to themselves. */
  private readonly ownerSplitwiseId: number;
  private readonly defaultCurrency: string;

  constructor(ownerId: number, ownerSplitwiseId: number, defaultCurrency: string) {
    this.ownerId = ownerId;
    this.ownerSplitwiseId = ownerSplitwiseId;
    this.defaultCurrency = defaultCurrency;
  }

  /** Everyone touched so far, in first-seen order. */
  results(): PersonResult[] {
    return [...this.cache.values()];
  }

  async resolve(person: SplitwiseUser): Promise<PersonResult> {
    const cached = this.cache.get(person.id);
    if (cached) return cached;

    const result = await this.lookupOrCreate(person);
    this.cache.set(person.id, result);
    return result;
  }

  /**
   * Read-only variant used by the preview step.
   *
   * Deliberately a separate method rather than a `dryRun` flag: a preview that
   * can write is a preview nobody can trust.
   */
  async plan(person: SplitwiseUser): Promise<PersonResult> {
    if (person.id === this.ownerSplitwiseId) {
      return this.describe(person, this.ownerId, "self");
    }

    const byId = await this.findBySplitwiseId(person.id);
    if (byId) return this.describe(person, byId.id, "splitwise_id");

    const byEmail = person.email ? await this.findByEmail(person.email) : undefined;
    if (byEmail) return this.describe(person, byEmail.id, "email");

    return this.describe(person, 0, "created");
  }

  private async lookupOrCreate(person: SplitwiseUser): Promise<PersonResult> {
    if (person.id === this.ownerSplitwiseId) {
      return this.describe(person, this.ownerId, "self");
    }

    const byId = await this.findBySplitwiseId(person.id);
    if (byId) return this.describe(person, byId.id, "splitwise_id");

    // The documented heuristic: someone who already has a SplitSmart account at
    // the address Splitwise knows them by IS that person. Stamping the
    // splitwise_id on them makes every later lookup an id match, so this branch
    // runs at most once per person per account.
    if (person.email) {
      const byEmail = await this.findByEmail(person.email);
      if (byEmail) {
        if (byEmail.splitwise_id === null) {
          await db
            .updateTable("users")
            .set({ splitwise_id: person.id })
            .where("id", "=", byEmail.id)
            // Belt and braces: splitwise_id is UNIQUE, and a concurrent import
            // could have claimed it. Losing the race is harmless — the id match
            // above will find it next time.
            .where("splitwise_id", "is", null)
            .execute();
        }
        return this.describe(person, byEmail.id, "email");
      }
    }

    // Nobody local: create a placeholder, exactly as POST /api/v1/friends does.
    // The recovery code is generated here or never — only its hash is kept.
    const recoveryCode = generateRecoveryCode();
    const created = await db
      .insertInto("users")
      .values({
        splitwise_id: person.id,
        first_name: displayFirstName(person),
        last_name: person.last_name ?? null,
        // A ghost may carry an unverified address; login refuses ghosts outright
        // so this can never become a working credential. See CLAUDE.md.
        email: person.email ?? null,
        default_currency: this.defaultCurrency,
        is_ghost: 1,
        recovery_code_hash: await hashPassword(normaliseRecoveryCode(recoveryCode)),
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    return { ...this.describe(person, created.id, "created"), recoveryCode };
  }

  private describe(
    person: SplitwiseUser,
    localUserId: number,
    matchedBy: PersonResult["matchedBy"],
  ): PersonResult {
    return {
      splitwiseId: person.id,
      localUserId,
      name: [displayFirstName(person), person.last_name].filter(Boolean).join(" "),
      email: person.email ?? null,
      matchedBy,
    };
  }

  private findBySplitwiseId(splitwiseId: number) {
    return db
      .selectFrom("users")
      .select(["id", "splitwise_id"])
      .where("splitwise_id", "=", splitwiseId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
  }

  private findByEmail(email: string) {
    return db
      .selectFrom("users")
      .select(["id", "splitwise_id"])
      // users.email is COLLATE NOCASE, so this is already case-insensitive.
      .where("email", "=", email)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
  }
}

/** Splitwise allows a blank first name; the column does not. */
function displayFirstName(person: SplitwiseUser): string {
  const first = person.first_name?.trim();
  if (first) return first;
  const last = person.last_name?.trim();
  if (last) return last;
  return person.email?.split("@")[0] ?? `Splitwise user ${person.id}`;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface LocalFootprint {
  groups: number;
  friends: number;
  expenses: number;
  /** Expenses of yours that already carry a Splitwise id — a previous import. */
  previouslyImported: number;
}

/**
 * What is already here.
 *
 * The wizard's "you already have data" warning is built from this, so it counts
 * only what the caller can actually see, not everything in the database.
 */
export async function localFootprint(userId: number): Promise<LocalFootprint> {
  const [groups, friendIds, expenses, imported] = await Promise.all([
    db
      .selectFrom("group_members")
      .innerJoin("groups", "groups.id", "group_members.group_id")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("group_members.user_id", "=", userId)
      .where("group_members.left_at", "is", null)
      .where("groups.deleted_at", "is", null)
      .executeTakeFirstOrThrow(),
    listRelatedUserIds(db, userId),
    db
      .selectFrom("expense_users")
      .innerJoin("expenses", "expenses.id", "expense_users.expense_id")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("expense_users.user_id", "=", userId)
      .where("expenses.deleted_at", "is", null)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("expense_users")
      .innerJoin("expenses", "expenses.id", "expense_users.expense_id")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where("expense_users.user_id", "=", userId)
      .where("expenses.deleted_at", "is", null)
      .where("expenses.splitwise_id", "is not", null)
      .executeTakeFirstOrThrow(),
  ]);

  return {
    groups: Number(groups.n),
    friends: friendIds.length,
    expenses: Number(expenses.n),
    previouslyImported: Number(imported.n),
  };
}

export interface ImportPreview {
  splitwiseAccount: { id: number; name: string; email: string | null };
  counts: { groups: number; friends: number; expenses: number; expensesCapped: boolean };
  /** Everyone the import would touch, and how each would be resolved. */
  people: PersonResult[];
  groups: Array<{ splitwiseId: number; name: string; members: number; alreadyImported: boolean }>;
  local: LocalFootprint;
  /** Plain-language things the user should read before pressing go. */
  warnings: string[];
}

/**
 * A full dry run: reads everything, writes nothing.
 *
 * Every `people` entry carries its `matchedBy`, so the wizard can show the
 * email matches as a list of real names rather than a vague disclaimer.
 */
export async function previewImport(
  client: SplitwiseClient,
  userId: number,
): Promise<ImportPreview> {
  const owner = await requireOwner(userId);
  const swMe = await client.getCurrentUser();

  const [swGroups, swFriends, expenseCount, local] = await Promise.all([
    client.getGroups(),
    client.getFriends(),
    client.countExpenses(),
    localFootprint(userId),
  ]);

  const resolver = new PersonResolver(userId, swMe.id, owner.default_currency);
  const people: PersonResult[] = [];
  const seen = new Set<number>();

  for (const person of [...swFriends, ...swGroups.flatMap((g) => g.members ?? [])]) {
    if (person.id === swMe.id || seen.has(person.id)) continue;
    seen.add(person.id);
    people.push(await resolver.plan(person));
  }

  const importable = swGroups.filter((g) => g.id !== NON_GROUP_ID);
  const existingGroups = await findGroupsBySplitwiseIds(importable.map((g) => g.id));

  const warnings: string[] = [];
  if (local.expenses > 0 || local.groups > 0 || local.friends > 0) {
    warnings.push(
      `This account already has ${local.groups} group(s), ${local.friends} friend(s) and ` +
        `${local.expenses} expense(s). Importing adds to that — it does not replace it.`,
    );
  }
  if (local.previouslyImported > 0) {
    warnings.push(
      `${local.previouslyImported} of your expenses were already imported from Splitwise. ` +
        `They will be matched on their Splitwise id and left alone, not duplicated.`,
    );
  }

  const byEmail = people.filter((p) => p.matchedBy === "email");
  warnings.push(
    "People are matched to existing SplitSmart accounts by email address. " +
      (byEmail.length > 0
        ? `${byEmail.length} of your Splitwise contacts match an existing account this way ` +
          `(${byEmail.map((p) => p.name).join(", ")}). Anyone whose Splitwise email differs ` +
          `from their SplitSmart email will be imported as a separate placeholder person.`
        : "None of your Splitwise contacts match an existing account, so they will all be " +
          "imported as placeholder people you can invite later."),
  );

  if (swMe.email && owner.email && swMe.email.toLowerCase() !== owner.email.toLowerCase()) {
    warnings.push(
      `Your Splitwise address (${swMe.email}) is not your SplitSmart address (${owner.email}). ` +
        `That is fine — you are matched by the key you supplied, not by email.`,
    );
  }
  if (expenseCount.capped) {
    warnings.push(
      `You have more than ${expenseCount.count} expenses; the count shown is a floor. ` +
        `All of them will still be imported.`,
    );
  }

  return {
    splitwiseAccount: {
      id: swMe.id,
      name: [displayFirstName(swMe), swMe.last_name].filter(Boolean).join(" "),
      email: swMe.email ?? null,
    },
    counts: {
      groups: importable.length,
      friends: swFriends.length,
      expenses: expenseCount.count,
      expensesCapped: expenseCount.capped,
    },
    people,
    groups: importable.map((g) => ({
      splitwiseId: g.id,
      name: g.name,
      members: g.members?.length ?? 0,
      alreadyImported: existingGroups.has(g.id),
    })),
    local,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Step 1 — friends
// ---------------------------------------------------------------------------

export interface FriendsImportResult {
  people: PersonResult[];
  created: number;
  matched: number;
}

/**
 * Imports the friend list, creating placeholders and explicit friendships.
 *
 * The friendship row matters: without it, someone you have no shared expense
 * with yet would vanish from your friends list on the next page load, because
 * `listRelatedUserIds` only derives from groups and expenses.
 */
export async function importFriends(
  client: SplitwiseClient,
  userId: number,
): Promise<FriendsImportResult> {
  const owner = await requireOwner(userId);
  const swMe = await client.getCurrentUser();
  await stampOwnerSplitwiseId(userId, swMe.id);

  const resolver = new PersonResolver(userId, swMe.id, owner.default_currency);
  const people: PersonResult[] = [];

  for (const friend of await client.getFriends()) {
    if (friend.id === swMe.id) continue;
    const person = await resolver.resolve(friend);
    await addFriendship(db, userId, person.localUserId);
    people.push(person);
  }

  return {
    people,
    created: people.filter((p) => p.matchedBy === "created").length,
    matched: people.filter((p) => p.matchedBy !== "created").length,
  };
}

// ---------------------------------------------------------------------------
// Step 2 — groups
// ---------------------------------------------------------------------------

export interface GroupImportResult {
  groups: Array<{
    splitwiseId: number;
    localGroupId: number;
    name: string;
    created: boolean;
    membersAdded: number;
  }>;
  people: PersonResult[];
  created: number;
  matched: number;
}

/**
 * Imports groups and their membership.
 *
 * Must run before expenses: a group expense cannot be written until the group
 * and everyone on it exists, and `createExpense` refuses participants who are
 * not members. Splitwise's group 0 ("Non-group expenses") is not a group and is
 * skipped — those expenses import with a NULL group_id.
 */
export async function importGroups(
  client: SplitwiseClient,
  userId: number,
): Promise<GroupImportResult> {
  const owner = await requireOwner(userId);
  const swMe = await client.getCurrentUser();
  await stampOwnerSplitwiseId(userId, swMe.id);

  const resolver = new PersonResolver(userId, swMe.id, owner.default_currency);
  const groups: GroupImportResult["groups"] = [];

  for (const swGroup of await client.getGroups()) {
    if (swGroup.id === NON_GROUP_ID) continue;

    const existing = await db
      .selectFrom("groups")
      .select(["id"])
      .where("splitwise_id", "=", swGroup.id)
      .executeTakeFirst();

    const localGroupId =
      existing?.id ??
      (
        await db
          .insertInto("groups")
          .values({
            splitwise_id: swGroup.id,
            name: swGroup.name,
            group_type: mapGroupType(swGroup.group_type),
            default_currency: owner.default_currency,
            simplify_by_default: swGroup.simplify_by_default ? 1 : 0,
            // No invite_token: an imported group is not something you have
            // decided to share yet. Rotate one in from the group screen.
            created_by: userId,
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;

    // The importer is always a member, even if Splitwise's member list is
    // stale — otherwise they cannot see the group they just imported.
    let membersAdded = (await ensureMember(localGroupId, userId, "creator")) ? 1 : 0;

    for (const member of swGroup.members ?? []) {
      if (member.id === swMe.id) continue;
      const person = await resolver.resolve(member);
      if (await ensureMember(localGroupId, person.localUserId, "import")) membersAdded++;
    }

    groups.push({
      splitwiseId: swGroup.id,
      localGroupId,
      name: swGroup.name,
      created: existing === undefined,
      membersAdded,
    });
  }

  const people = resolver.results();
  return {
    groups,
    people,
    created: people.filter((p) => p.matchedBy === "created").length,
    matched: people.filter((p) => p.matchedBy !== "created").length,
  };
}

/** Splitwise's vocabulary is not ours; anything unrecognised becomes 'other'. */
function mapGroupType(type: string | null | undefined): string {
  switch ((type ?? "").toLowerCase()) {
    case "apartment":
    case "house":
    case "home":
      return "home";
    case "trip":
      return "trip";
    case "couple":
      return "couple";
    case "event":
      return "event";
    case "project":
      return "project";
    default:
      return "other";
  }
}

/** Returns true if a membership row was added or revived. */
async function ensureMember(
  groupId: number,
  userId: number,
  joinedVia: "import" | "creator",
): Promise<boolean> {
  const existing = await db
    .selectFrom("group_members")
    .select(["user_id", "left_at"])
    .where("group_id", "=", groupId)
    .where("user_id", "=", userId)
    .executeTakeFirst();

  if (existing && existing.left_at === null) return false;

  if (existing) {
    // They left and Splitwise says they are back. Clearing left_at restores
    // them without touching a single expense.
    await db
      .updateTable("group_members")
      .set({ left_at: null })
      .where("group_id", "=", groupId)
      .where("user_id", "=", userId)
      .execute();
    return true;
  }

  await db
    .insertInto("group_members")
    .values({
      group_id: groupId,
      user_id: userId,
      role: joinedVia === "creator" ? "owner" : "member",
      joined_via: joinedVia,
    })
    .execute();
  return true;
}

// ---------------------------------------------------------------------------
// Step 3 — expenses
// ---------------------------------------------------------------------------

export interface ExpensePageResult {
  /** Where this page started, echoed back so a client can log progress. */
  offset: number;
  /** How many Splitwise rows this page contained, before any filtering. */
  fetched: number;
  imported: number;
  /** Already present from an earlier run, matched on splitwise_id. */
  alreadyPresent: number;
  skipped: SkippedRow[];
  /** Pass this back to import the next page. Null when there are none left. */
  nextOffset: number | null;
  done: boolean;
}

/**
 * Imports one page of expenses.
 *
 * Paged rather than all-at-once so the wizard can show real progress and so a
 * failure halfway through costs you one page, not the whole run. Re-running a
 * page is free — everything already imported matches on `splitwise_id`.
 */
export async function importExpensePage(
  client: SplitwiseClient,
  userId: number,
  params: { offset?: number; limit?: number } = {},
): Promise<ExpensePageResult> {
  const owner = await requireOwner(userId);
  const swMe = await client.getCurrentUser();
  await stampOwnerSplitwiseId(userId, swMe.id);

  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;

  const page = await client.getExpenses({ limit, offset });
  const resolver = new PersonResolver(userId, swMe.id, owner.default_currency);

  const [decimalsByCurrency, categoryIds, groupIdBySplitwiseId] = await Promise.all([
    loadCurrencyDecimals(),
    loadCategoryIds(),
    loadGroupMap(),
  ]);

  const result: ExpensePageResult = {
    offset,
    fetched: page.length,
    imported: 0,
    alreadyPresent: 0,
    skipped: [],
    // Splitwise caps page size server-side, so a short page — not a page
    // shorter than `limit` — is the only reliable end-of-list signal.
    nextOffset: page.length === 0 ? null : offset + page.length,
    done: page.length === 0,
  };

  for (const swExpense of page) {
    try {
      const outcome = await importOneExpense(swExpense, {
        userId,
        resolver,
        decimalsByCurrency,
        categoryIds,
        groupIdBySplitwiseId,
      });
      if (outcome === "imported") result.imported++;
      else if (outcome === "present") result.alreadyPresent++;
    } catch (err) {
      result.skipped.push({
        splitwiseId: swExpense.id,
        description: swExpense.description ?? "(no description)",
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

interface ExpenseContext {
  userId: number;
  resolver: PersonResolver;
  decimalsByCurrency: Map<string, number>;
  categoryIds: Set<number>;
  groupIdBySplitwiseId: Map<number, number>;
}

/** Throws with a human-readable reason; the caller turns that into a skip. */
async function importOneExpense(
  swExpense: SplitwiseExpense,
  ctx: ExpenseContext,
): Promise<"imported" | "present" | "skipped"> {
  const existing = await db
    .selectFrom("expenses")
    .select("id")
    .where("splitwise_id", "=", swExpense.id)
    .executeTakeFirst();
  if (existing) return "present";

  // A tombstone in Splitwise affects nobody's balance. Importing it would mean
  // writing a row purely to soft-delete it, so it is left behind on purpose.
  if (swExpense.deleted_at) {
    throw new Error("Deleted in Splitwise");
  }

  const currency = (swExpense.currency_code ?? "").toUpperCase();
  const decimals = ctx.decimalsByCurrency.get(currency);
  if (decimals === undefined) {
    throw new Error(`Unknown currency ${currency || "(none)"}`);
  }

  const swGroupId = swExpense.group_id ?? NON_GROUP_ID;
  let groupId: number | null = null;
  if (swGroupId !== NON_GROUP_ID) {
    groupId = ctx.groupIdBySplitwiseId.get(swGroupId) ?? null;
    if (groupId === null) {
      throw new Error(`Group ${swGroupId} has not been imported — run the groups step first`);
    }
  }

  const swUsers = swExpense.users ?? [];
  if (swUsers.length === 0) throw new Error("Expense has no participants");

  const costMinor = parseAmount(swExpense.cost, decimals);

  const participants: Array<{ userId: number; paidMinor: number; input: number }> = [];
  for (const share of swUsers) {
    const person = share.user ?? (share.user_id ? { id: share.user_id } : null);
    if (!person?.id) throw new Error("Participant with no user id");

    const resolved = await ctx.resolver.resolve(person as SplitwiseUser);
    participants.push({
      userId: resolved.localUserId,
      paidMinor: parseAmount(share.paid_share ?? "0", decimals),
      // Splitwise's own owed_share, imported as an `exact` split. Re-deriving
      // it from a split type would move cents, and cents are balances.
      input: parseAmount(share.owed_share ?? "0", decimals),
    });
  }

  // Splitwise lets someone leave a group while their expenses stay behind.
  // createExpense rejects non-members, so put them back rather than dropping
  // the expense — a missing expense is a wrong balance.
  if (groupId !== null) {
    for (const p of participants) await ensureMember(groupId, p.userId, "import");
  }

  const categoryId =
    swExpense.category?.id && ctx.categoryIds.has(swExpense.category.id)
      ? swExpense.category.id
      : null;

  await createExpense({
    splitwiseId: swExpense.id,
    groupId,
    description: swExpense.description || "(no description)",
    details: swExpense.details ?? null,
    costMinor,
    currencyCode: currency,
    date: swExpense.date,
    categoryId,
    splitType: "exact",
    isPayment: swExpense.payment === true,
    participants,
    createdBy: ctx.userId,
    // One activity row per expense would bury the feed under an import. The
    // route writes a single summary entry instead.
    recordActivity: false,
  });

  return "imported";
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

async function requireOwner(userId: number) {
  const owner = await db
    .selectFrom("users")
    .select(["id", "email", "splitwise_id", "default_currency", "is_ghost"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  return owner;
}

/**
 * Records the importer's own Splitwise id so their rows resolve to themselves.
 *
 * Skipped when the id is already taken by another local row — that means two
 * accounts here are importing the same Splitwise account, and silently moving
 * the id between them would be worse than leaving it where it is.
 */
async function stampOwnerSplitwiseId(userId: number, splitwiseId: number): Promise<void> {
  await db
    .updateTable("users")
    .set({ splitwise_id: splitwiseId })
    .where("id", "=", userId)
    .where("splitwise_id", "is", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("users as other").select("other.id").where("other.splitwise_id", "=", splitwiseId),
        ),
      ),
    )
    .execute();
}

async function loadCurrencyDecimals(): Promise<Map<string, number>> {
  const rows = await db.selectFrom("currencies").select(["code", "decimal_places"]).execute();
  return new Map(rows.map((r) => [r.code, r.decimal_places]));
}

async function loadCategoryIds(): Promise<Set<number>> {
  const rows = await db.selectFrom("categories").select("id").execute();
  return new Set(rows.map((r) => r.id));
}

async function loadGroupMap(): Promise<Map<number, number>> {
  const rows = await db
    .selectFrom("groups")
    .select(["id", "splitwise_id"])
    .where("splitwise_id", "is not", null)
    .where("deleted_at", "is", null)
    .execute();
  return new Map(rows.map((r) => [r.splitwise_id as number, r.id]));
}

async function findGroupsBySplitwiseIds(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .selectFrom("groups")
    .select("splitwise_id")
    .where("splitwise_id", "in", ids)
    .execute();
  return new Set(rows.map((r) => r.splitwise_id as number));
}

export type { SplitwiseGroup };
