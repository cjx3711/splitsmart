/**
 * Splitwise import.
 *
 * Pulls a Splitwise account into SplitSmart, in the order the data depends on
 * itself: people, then groups, then expenses. Each step is a separate call that
 * can be run on its own and re-run safely, which is what makes the whole thing
 * drivable from a wizard, or from a test, one HTTP request at a time.
 *
 * FOUR RULES THIS MODULE LIVES BY:
 *
 * 1. IDENTITY IS `metadata.splitwise_id` FIRST, EMAIL SECOND. Every row we
 *    create carries the Splitwise id it came from in the JSON metadata bag, so
 *    a second run matches instead of duplicating. The native PK is a fresh
 *    ULID — the original integer is not reused as `id`. Only when there is no
 *    id match do we fall back to matching an existing local account by email;
 *    that is the one heuristic in here, and the UI has to say so out loud
 *    before the user starts.
 *
 * 2. NOTHING IS WRITTEN TWICE. Groups and expenses are looked up by
 *    `json_extract(metadata, '$.splitwise_id')` before insert. Re-running a
 *    step is a no-op plus a report.
 *
 * 3. EXPENSES GO THROUGH `createExpense`. No exceptions. See CLAUDE.md rule 3.
 *    Splitwise's own per-person `owed_share` values are imported as an `exact`
 *    split so the allocation is preserved byte for byte rather than re-derived
 *    (re-deriving would move cents, and therefore balances).
 *
 * 4. A BAD ROW IS SKIPPED, NEVER FUDGED. Unknown currency, a group that has not
 *    been imported yet, shares that do not add up; each of those returns a
 *    skip with a reason instead of a guess. A partial import you can see is
 *    worth more than a complete one you cannot trust.
 *
 * The API key never reaches this module as anything but a live client object,
 * and is never persisted. See src/splitwise/client.ts.
 */
import { db, transaction } from "../db/index.ts";
import { parseAmount } from "./money.ts";
import { createExpense, importStamp, markImportSynced, updateExpense } from "./expenses.ts";
import { createComment } from "./comments.ts";
import { addFriendship, listRelatedUserIds } from "./friends.ts";
import { ulid } from "./ulid.ts";
import {
  metadataFromSplitwise,
  metadataWithSplitwiseId,
  parseMetadata,
  splitwiseIdOf,
  splitwiseIdSql,
} from "./metadata.ts";
import type {
  SplitwiseClient,
  SplitwiseComment,
  SplitwiseExpense,
  SplitwiseGroup,
  SplitwiseUser,
} from "../splitwise/client.ts";

/** Splitwise's pseudo-group for expenses that belong to no group. */
const NON_GROUP_ID = 0;

export interface PersonResult {
  splitwiseId: number;
  /** Null in a preview for someone who would be created. */
  localUserId: string | null;
  name: string;
  email: string | null;
  /** How this person was resolved: the UI shows the email matches explicitly. */
  matchedBy: "splitwise_id" | "email" | "self" | "created";
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
 * once. Not shared between requests; each import call builds a fresh one, and
 * the database is the only durable state.
 */
export class PersonResolver {
  private readonly cache = new Map<number, PersonResult>();

  // Assigned in the body rather than declared as constructor parameter
  // properties: `--experimental-strip-types` rejects those outright
  // (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX), and there is no build step in dev.
  /** The local account doing the import. */
  private readonly ownerId: string;
  /** Their Splitwise id, so their own rows resolve to themselves. */
  private readonly ownerSplitwiseId: number;
  private readonly defaultCurrency: string;

  constructor(ownerId: string, ownerSplitwiseId: number, defaultCurrency: string) {
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

    return this.describe(person, null, "created");
  }

  private async lookupOrCreate(person: SplitwiseUser): Promise<PersonResult> {
    if (person.id === this.ownerSplitwiseId) {
      return this.describe(person, this.ownerId, "self");
    }

    const byId = await this.findBySplitwiseId(person.id);
    if (byId) return this.describe(person, byId.id, "splitwise_id");

    // The documented heuristic: someone who already has a SplitSmart account at
    // the address Splitwise knows them by IS that person. Stamping the
    // splitwise_id into metadata makes every later lookup an id match, so this
    // branch runs at most once per person per account.
    if (person.email) {
      const byEmail = await this.findByEmail(person.email);
      if (byEmail) {
        if (splitwiseIdOf(byEmail.metadata) === null) {
          await db
            .updateTable("users")
            .set({ metadata: metadataWithSplitwiseId(byEmail.metadata, person.id) })
            .where("id", "=", byEmail.id)
            .where(splitwiseIdSql(), "is", null)
            .execute();
        }
        return this.describe(person, byEmail.id, "email");
      }
    }

    // Nobody local: create a placeholder person, exactly as POST /friends does
    // minus the invite. No guest link is minted here: importing your Splitwise
    // history is not deciding to share it with the people in it. Mint one from
    // the friend or group screen when you mean to. See docs/GUEST.md.
    const { id, createdAt } = originalInstant(person.created_at);
    const created = await transaction(async (trx) => {
      return trx
        .insertInto("users")
        .values({
          id,
          created_at: createdAt,
          metadata: metadataFromSplitwise(person.id),
          first_name: displayFirstName(person),
          last_name: person.last_name ?? null,
          // A ghost may carry an unverified address; login refuses ghosts outright
          // so this can never become a working credential. See CLAUDE.md.
          email: person.email ?? null,
          default_currency: this.defaultCurrency,
          is_ghost: 1,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
    });

    return this.describe(person, created.id, "created");
  }

  private describe(
    person: SplitwiseUser,
    localUserId: string | null,
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
      .select(["id", "metadata"])
      .where(splitwiseIdSql(), "=", splitwiseId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
  }

  private findByEmail(email: string) {
    return db
      .selectFrom("users")
      .select(["id", "metadata"])
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

function localId(person: PersonResult): string {
  if (person.localUserId === null) {
    throw new Error(`Splitwise user ${person.splitwiseId} was not resolved to a local account`);
  }
  return person.localUserId;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface LocalFootprint {
  groups: number;
  friends: number;
  expenses: number;
  /** Expenses of yours that already carry a Splitwise id (a previous import). */
  previouslyImported: number;
}

/**
 * What is already here.
 *
 * The wizard's "you already have data" warning is built from this, so it counts
 * only what the caller can actually see, not everything in the database.
 */
export async function localFootprint(userId: string): Promise<LocalFootprint> {
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
      .where(splitwiseIdSql("expenses"), "is not", null)
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
  counts: {
    groups: number;
    friends: number;
    expenses: number;
    expensesCapped: boolean;
    /**
     * Comments on the first page of expenses, per Splitwise's own
     * `comments_count`. A floor, like the expense count, and shown as one.
     */
    comments: number;
  };
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
  userId: string,
): Promise<ImportPreview> {
  const owner = await requireOwner(userId);
  const swMe = await client.getCurrentUser();

  const [swGroups, swFriends, expenseCount, local, firstPage] = await Promise.all([
    client.getGroups(),
    client.getFriends(),
    client.countExpenses(),
    localFootprint(userId),
    // One page, purely to see what Splitwise says about comments, recurrence and
    // receipts. The warnings below are the whole reason: a wizard that mentions
    // these only afterwards is a wizard that surprised you.
    client.getExpenses({ limit: 100, offset: 0 }),
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
        `${local.expenses} expense(s). Importing adds to that; it does not replace it.`,
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
        `That is fine; you are matched by the key you supplied, not by email.`,
    );
  }
  if (expenseCount.capped) {
    warnings.push(
      `You have more than ${expenseCount.count} expenses; the count shown is a floor. ` +
        `All of them will still be imported.`,
    );
  }

  const commentCount = firstPage.reduce((sum, e) => sum + (e.comments_count ?? 0), 0);
  if (commentCount > 0) {
    warnings.push(
      "Comments come across too, including the automatic ones Splitwise writes when " +
        "somebody edits a bill. They are the only edit history Splitwise will give us, so " +
        "they are imported rather than dropped.",
    );
  }

  // Deliberately NOT turned into live templates. Generating future copies of a
  // series this account never asked us to originate is the one import behaviour
  // that would create money on its own. See docs/PARITY.md slice 2.
  if (firstPage.some((e) => e.repeats === true)) {
    warnings.push(
      "Recurring expenses are imported as the bills that already happened. Future repeats " +
        "are not scheduled here; set the repeat up again in SplitSmart if you want it to carry on.",
    );
  }

  // One warning, not a skip per expense: a receipt image is not part of the
  // ledger, and refusing the whole bill over it would be absurd.
  if (firstPage.some((e) => e.receipt?.original || e.receipt?.large)) {
    warnings.push(
      "Receipt images are not imported. This app has no file storage at all, by design.",
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
      comments: commentCount,
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
// Step 1: friends
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
  userId: string,
): Promise<FriendsImportResult> {
  const owner = await requireOwner(userId);
  const swMe = await client.getCurrentUser();
  await stampOwnerSplitwiseId(userId, swMe.id);

  const resolver = new PersonResolver(userId, swMe.id, owner.default_currency);
  const people: PersonResult[] = [];

  for (const friend of await client.getFriends()) {
    if (friend.id === swMe.id) continue;
    const person = await resolver.resolve(friend);
    await addFriendship(userId, localId(person), userId);
    people.push(person);
  }

  return {
    people,
    created: people.filter((p) => p.matchedBy === "created").length,
    matched: people.filter((p) => p.matchedBy !== "created").length,
  };
}

// ---------------------------------------------------------------------------
// Step 2: groups
// ---------------------------------------------------------------------------

export interface GroupImportResult {
  groups: Array<{
    splitwiseId: number;
    localGroupId: string;
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
 * skipped; those expenses import with a NULL group_id.
 */
export async function importGroups(
  client: SplitwiseClient,
  userId: string,
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
      .where(splitwiseIdSql(), "=", swGroup.id)
      .executeTakeFirst();

    const localGroupId =
      existing?.id ??
      (
        await transaction(async (trx) => {
          const { id, createdAt } = originalInstant(swGroup.created_at);
          return trx
            .insertInto("groups")
            .values({
              id,
              created_at: createdAt,
              metadata: metadataFromSplitwise(swGroup.id),
              name: swGroup.name,
              group_type: mapGroupType(swGroup.group_type),
              default_currency: owner.default_currency,
              simplify_by_default: swGroup.simplify_by_default ? 1 : 0,
              // No guest link either: an imported group is not something you
              // have decided to share yet. Mint one from the group screen.
              created_by: userId,
            })
            .returning("id")
            .executeTakeFirstOrThrow();
        })
      ).id;

    // The importer is always a member, even if Splitwise's member list is
    // stale; otherwise they cannot see the group they just imported.
    let membersAdded = (await ensureMember(localGroupId, userId, "creator")) ? 1 : 0;

    for (const member of swGroup.members ?? []) {
      if (member.id === swMe.id) continue;
      const person = await resolver.resolve(member);
      if (await ensureMember(localGroupId, localId(person), "import")) membersAdded++;
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
  groupId: string,
  userId: string,
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
// Step 3: expenses
// ---------------------------------------------------------------------------

export interface ExpensePageResult {
  /** Where this page started, echoed back so a client can log progress. */
  offset: number;
  /** How many Splitwise rows this page contained, before any filtering. */
  fetched: number;
  imported: number;
  /** Already present from an earlier run, matched on splitwise_id. */
  alreadyPresent: number;
  /**
   * Already here, changed in Splitwise since, and overwritten because nothing had
   * touched the local row. See `refreshExpense`.
   */
  refreshed: number;
  /** Comments imported alongside these expenses, when Splitwise nested them. */
  commentsImported: number;
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
 * page is free; everything already imported matches on `metadata.splitwise_id`.
 */
export async function importExpensePage(
  client: SplitwiseClient,
  userId: string,
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
    refreshed: 0,
    commentsImported: 0,
    skipped: [],
    // Splitwise caps page size server-side, so a short page (not a page
    // shorter than `limit`: is the only reliable end-of-list signal.
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
      if (outcome.status === "imported") result.imported++;
      else if (outcome.status === "refreshed") result.refreshed++;
      else if (outcome.status === "present") result.alreadyPresent++;
      result.commentsImported += outcome.commentsImported;
      result.skipped.push(...outcome.skippedComments);
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
  userId: string;
  resolver: PersonResolver;
  decimalsByCurrency: Map<string, number>;
  categoryIds: Set<number>;
  groupIdBySplitwiseId: Map<number, string>;
}

interface ExpenseOutcome {
  status: "imported" | "refreshed" | "present";
  commentsImported: number;
  /** Comments that could not be imported exactly. Reported, never fudged. */
  skippedComments: SkippedRow[];
}

/** Throws with a human-readable reason; the caller turns that into a skip. */
async function importOneExpense(
  swExpense: SplitwiseExpense,
  ctx: ExpenseContext,
): Promise<ExpenseOutcome> {
  const existing = await db
    .selectFrom("expenses")
    .select([
      "id", "created_at", "updated_at", "metadata", "description", "details",
      "cost_minor", "currency_code", "date", "category_id", "is_payment", "group_id",
    ])
    .where(splitwiseIdSql(), "=", swExpense.id)
    .executeTakeFirst();

  // A tombstone in Splitwise affects nobody's balance. Importing it would mean
  // writing a row purely to soft-delete it, so it is left behind on purpose. A
  // row deleted in Splitwise AFTER we imported it is left alone rather than
  // deleted here: that is somebody's balance, and this is an import, not a sync.
  if (swExpense.deleted_at) {
    if (existing) return { status: "present", commentsImported: 0, skippedComments: [] };
    throw new Error("Deleted in Splitwise");
  }

  const currency = (swExpense.currency_code ?? "").toUpperCase();
  const decimals = ctx.decimalsByCurrency.get(currency);
  if (decimals === undefined) {
    throw new Error(`Unknown currency ${currency || "(none)"}`);
  }

  const swGroupId = swExpense.group_id ?? NON_GROUP_ID;
  let groupId: string | null = null;
  if (swGroupId !== NON_GROUP_ID) {
    groupId = ctx.groupIdBySplitwiseId.get(swGroupId) ?? null;
    if (groupId === null) {
      throw new Error(`Group ${swGroupId} has not been imported; run the groups step first`);
    }
  }

  const swUsers = swExpense.users ?? [];
  if (swUsers.length === 0) throw new Error("Expense has no participants");

  const costMinor = parseAmount(swExpense.cost, decimals);

  const participants: Array<{ userId: string; paidMinor: number; input: number }> = [];
  for (const share of swUsers) {
    const person = share.user ?? (share.user_id ? { id: share.user_id } : null);
    if (!person?.id) throw new Error("Participant with no user id");

    const resolved = await ctx.resolver.resolve(person as SplitwiseUser);
    participants.push({
      userId: localId(resolved),
      paidMinor: parseAmount(share.paid_share ?? "0", decimals),
      // Splitwise's own owed_share, imported as an `exact` split. Re-deriving
      // it from a split type would move cents, and cents are balances.
      input: parseAmount(share.owed_share ?? "0", decimals),
    });
  }

  // Splitwise lets someone leave a group while their expenses stay behind.
  // createExpense rejects non-members, so put them back rather than dropping
  // the expense; a missing expense expense is a wrong balance.
  if (groupId !== null) {
    for (const p of participants) await ensureMember(groupId, p.userId, "import");
  }

  const categoryId =
    swExpense.category?.id && ctx.categoryIds.has(swExpense.category.id)
      ? swExpense.category.id
      : null;

  const fields = {
    groupId,
    description: swExpense.description || "(no description)",
    details: swExpense.details ?? null,
    costMinor,
    currencyCode: currency,
    date: swExpense.date,
    categoryId,
    // Splitwise's own allocation, kept as an `exact` split. A refresh keeps it
    // exact too: re-running computeSplit would move cents nobody asked to move.
    splitType: "exact" as const,
    isPayment: swExpense.payment === true,
    participants,
  };

  if (existing) {
    const status = await refreshExpense(existing, fields, swExpense, ctx.userId);
    const comments = await importNestedComments(existing.id, swExpense, ctx);
    return { status, ...comments };
  }

  const { id, createdAt } = originalInstant(swExpense.created_at, swExpense.date);
  const localId_ = await createExpense({
    ...fields,
    id,
    createdAt,
    metadata: { splitwise_id: swExpense.id },
    createdBy: ctx.userId,
    // One activity row per expense would bury the feed under an import. The
    // route writes a single summary entry instead.
    recordActivity: false,
  });

  const comments = await importNestedComments(localId_, swExpense, ctx);
  return { status: "imported", ...comments };
}

type LocalExpenseRow = {
  id: string;
  created_at: string;
  updated_at: string;
  metadata: string;
  description: string;
  details: string | null;
  cost_minor: number;
  currency_code: string;
  date: string;
  category_id: number | null;
  is_payment: number;
  group_id: string | null;
};

/**
 * Re-import as update in place.
 *
 * Three outcomes, and the middle one is the point:
 *
 *   nothing changed upstream          left alone, reported as already present
 *   changed, local row untouched      overwritten through `updateExpense`
 *   changed, local row edited HERE    skipped with a reason, never overwritten
 *
 * The last case is the whole reason this is not a blind overwrite. Somebody may
 * have fixed a split or a category in SplitSmart after importing; silently
 * replacing that with Splitwise's older version would destroy work and move a
 * balance with no trace.
 *
 * "Untouched" is `updated_at == created_at` (never edited at all, which
 * `createExpense` guarantees for imported rows) or `updated_at` equal to the
 * `splitwise_synced_at` stamp a previous refresh left behind. Both come from
 * `markImportSynced`, so a refresh does not make the row look hand-edited to the
 * next run.
 *
 * The split stays `exact` either way — see rule 3's note in this module's header.
 */
async function refreshExpense(
  existing: LocalExpenseRow,
  fields: {
    groupId: string | null;
    description: string;
    details: string | null;
    costMinor: number;
    currencyCode: string;
    date: string;
    categoryId: number | null;
    splitType: "exact";
    isPayment: boolean;
    participants: Array<{ userId: string; paidMinor: number; input: number }>;
  },
  swExpense: SplitwiseExpense,
  importerId: string,
): Promise<"refreshed" | "present"> {
  const localShares = await db
    .selectFrom("expense_users")
    .select(["user_id", "paid_share_minor", "owed_share_minor"])
    .where("expense_id", "=", existing.id)
    .execute();

  const sameShares =
    localShares.length === fields.participants.length &&
    fields.participants.every((p) => {
      const local = localShares.find((s) => s.user_id === p.userId);
      return (
        local !== undefined &&
        local.paid_share_minor === p.paidMinor &&
        local.owed_share_minor === p.input
      );
    });

  const unchanged =
    sameShares &&
    existing.description === fields.description &&
    (existing.details ?? null) === fields.details &&
    existing.cost_minor === fields.costMinor &&
    existing.currency_code === fields.currencyCode &&
    // Parsed rather than string-compared: the stored value is normalised and the
    // source may be date-only, so "2026-03-01" and "2026-03-01T00:00:00Z" are the
    // same instant written two ways.
    Date.parse(existing.date) === Date.parse(fields.date) &&
    existing.category_id === fields.categoryId &&
    existing.is_payment === (fields.isPayment ? 1 : 0) &&
    existing.group_id === fields.groupId;

  if (unchanged) return "present";

  const synced = parseMetadata(existing.metadata).splitwise_synced_at;
  const untouched =
    existing.updated_at === existing.created_at ||
    (typeof synced === "string" && existing.updated_at === synced);

  if (!untouched) {
    throw new Error("Changed in Splitwise, but edited here since import: local edits, not refreshed");
  }

  // Full ISO with milliseconds, unlike the `YYYY-MM-DD HH:MM:SS` a native edit
  // writes: that is what makes "the importer last touched this" impossible to
  // confuse with "a person edited it in the same second". See importStamp.
  const stamp = importStamp();

  await updateExpense(existing.id, {
    ...fields,
    // The person running the import is who touched it, and saying so is honest:
    // they are the one who asked Splitwise for the newer version.
    updatedBy: importerId,
    updatedAt: stamp,
    // Written in the same statement as `updated_at`, so the two agree and the
    // next run can still tell an import from a person.
    metadata: {
      ...parseMetadata(existing.metadata),
      splitwise_id: swExpense.id,
      splitwise_synced_at: stamp,
    },
    // Neither a feed entry nor a system comment: a refresh is not somebody
    // editing a bill and must not read like one.
    recordActivity: false,
  });

  return "refreshed";
}

// ---------------------------------------------------------------------------
// Step 4: comments
// ---------------------------------------------------------------------------
//
// TWO SHAPES, BOTH SUPPORTED, on purpose. Splitwise's `get_expenses` may nest
// complete `comments[]` on each expense, or it may only give a `comments_count`.
// The fixture that would settle which (docs/PARITY.md, "Capture what import will
// need") can only be captured against a live account while the API is still
// free, and betting on the wrong answer means either a wasted request per expense
// or silently importing no comments at all. So:
//
//   nested         imported alongside the expense, no extra request, no new step
//   count only     `POST /api/v1/import/comments` walks the expenses that have a
//                  count and fetches `get_comments` for each
//
// Both paths converge on `importComment` below, so identity, authorship and
// skip-don't-fudge behave identically whichever one runs.

export interface CommentsPageResult {
  offset: number;
  /** Local expenses examined in this page. */
  scanned: number;
  /** Expenses we actually asked Splitwise about. */
  fetched: number;
  imported: number;
  /** Expenses whose comments were already here, or that have none. */
  alreadyPresent: number;
  skipped: SkippedRow[];
  nextOffset: number | null;
  done: boolean;
}

/**
 * Imports comments for one page of already-imported expenses.
 *
 * Runs AFTER expenses, because `comments.expense_id` is a foreign key. Paged for
 * the same reason the expense step is: one request per page keeps a large
 * account from holding a single HTTP request open for minutes.
 *
 * Expenses are ordered by their local ULID so the offset is stable between calls,
 * and every expense that has already had its comments fetched is skipped on the
 * `splitwise_comments_synced_at` stamp, which makes a second run nearly free
 * rather than a re-fetch of the whole account.
 */
export async function importCommentsPage(
  client: SplitwiseClient,
  userId: string,
  params: { offset?: number; limit?: number } = {},
): Promise<CommentsPageResult> {
  const owner = await requireOwner(userId);
  const swMe = await client.getCurrentUser();
  await stampOwnerSplitwiseId(userId, swMe.id);

  const offset = params.offset ?? 0;
  const limit = params.limit ?? 25;

  const resolver = new PersonResolver(userId, swMe.id, owner.default_currency);

  const candidates = await db
    .selectFrom("expenses")
    .select(["id", "metadata", "description"])
    .where(splitwiseIdSql(), "is not", null)
    .where("deleted_at", "is", null)
    .orderBy("id")
    .limit(limit)
    .offset(offset)
    .execute();

  const result: CommentsPageResult = {
    offset,
    scanned: candidates.length,
    fetched: 0,
    imported: 0,
    alreadyPresent: 0,
    skipped: [],
    nextOffset: candidates.length === 0 ? null : offset + candidates.length,
    done: candidates.length < limit,
  };

  for (const expense of candidates) {
    const meta = parseMetadata(expense.metadata);
    const swId = splitwiseIdOf(expense.metadata);
    if (swId === null) continue;

    // Already fetched once. Splitwise comments are append-only in practice, and
    // re-reading every expense on every run would be one HTTP request per bill
    // for no new data.
    if (typeof meta.splitwise_comments_synced_at === "string") {
      result.alreadyPresent++;
      continue;
    }
    // Splitwise itself said there are none.
    if (meta.splitwise_comments_count === 0) {
      result.alreadyPresent++;
      continue;
    }

    try {
      const swComments = await client.getComments(swId);
      result.fetched++;

      for (const swComment of swComments) {
        const outcome = await importComment(expense.id, swComment, resolver);
        if (outcome.imported) result.imported++;
        if (outcome.skipped) result.skipped.push(outcome.skipped);
      }

      await markImportSynced(expense.id, {
        splitwise_comments_synced_at: new Date().toISOString(),
        splitwise_comments_count: swComments.length,
      });
    } catch (err) {
      // One unreachable expense must not abort the page; the next run retries it
      // because nothing was stamped.
      result.skipped.push({
        splitwiseId: swId,
        description: expense.description,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    await client.wait();
  }

  return result;
}

/**
 * Imports the comments Splitwise nested on an expense, if it nested any.
 *
 * A count of zero is recorded so the paged step can skip the expense entirely
 * rather than spending a request to be told the same thing.
 */
async function importNestedComments(
  localExpenseId: string,
  swExpense: SplitwiseExpense,
  ctx: ExpenseContext,
): Promise<{ commentsImported: number; skippedComments: SkippedRow[] }> {
  const nested = swExpense.comments;
  const count = swExpense.comments_count;

  if (nested === undefined) {
    // No nested array. Remember the count if we were given one, so the paged
    // step knows which expenses are worth a request.
    if (typeof count === "number") {
      await markImportSynced(localExpenseId, { splitwise_comments_count: count });
    }
    return { commentsImported: 0, skippedComments: [] };
  }

  let commentsImported = 0;
  const skippedComments: SkippedRow[] = [];

  for (const swComment of nested) {
    const outcome = await importComment(localExpenseId, swComment, ctx.resolver);
    if (outcome.imported) commentsImported++;
    if (outcome.skipped) skippedComments.push(outcome.skipped);
  }

  await markImportSynced(localExpenseId, {
    splitwise_comments_synced_at: new Date().toISOString(),
    splitwise_comments_count: nested.length,
  });

  return { commentsImported, skippedComments };
}

/**
 * One comment, matched on `metadata.splitwise_id`.
 *
 * Rules, all of them the same rules the expense import lives by:
 *
 *   - identity is the Splitwise id; the PK is a fresh ULID minted from
 *     `created_at`, so the thread sorts in the order it was written
 *   - System rows are imported as well as User ones. They are the ONLY edit
 *     history Splitwise will ever hand over, and dropping them would leave an
 *     imported bill silent about why its amount changed
 *   - an author nobody has seen becomes a ghost, via the shared PersonResolver,
 *     rather than costing us the comment
 *   - deleted at the source is skipped, exactly like a deleted expense
 *   - visibility is not enforced: this is replaying history, and Splitwise lets
 *     somebody comment and then leave the group
 */
async function importComment(
  localExpenseId: string,
  swComment: SplitwiseComment,
  resolver: PersonResolver,
): Promise<{ imported: boolean; skipped?: SkippedRow }> {
  const describe = (reason: string): SkippedRow => ({
    splitwiseId: swComment.id,
    description: `comment on expense ${localExpenseId}`,
    reason,
  });

  if (swComment.deleted_at) return { imported: false };

  const content = (swComment.content ?? "").trim();
  if (content === "") return { imported: false, skipped: describe("Empty comment") };

  const existing = await db
    .selectFrom("comments")
    .select("id")
    .where(splitwiseIdSql("comments"), "=", swComment.id)
    .executeTakeFirst();
  if (existing) return { imported: false };

  const author = swComment.user;
  if (!author?.id) {
    return { imported: false, skipped: describe("Comment has no author") };
  }

  const resolved = await resolver.resolve(author);

  const { id, createdAt } = originalInstant(swComment.created_at);

  await createComment({
    id,
    createdAt,
    expenseId: localExpenseId,
    userId: localId(resolved),
    content,
    // Splitwise capitalises these: "User" / "System". Anything unrecognised is
    // treated as somebody having typed it, which is the safer default: it stays
    // deletable by its author rather than becoming permanent history.
    kind: (swComment.comment_type ?? "").toLowerCase() === "system" ? "system" : "user",
    metadata: { splitwise_id: swComment.id },
    // One summary feed entry per import run, not one per comment.
    recordActivity: false,
    // See the note above.
    enforceVisibility: false,
  });

  return { imported: true };
}

// ---------------------------------------------------------------------------
// Shared lookups
// ---------------------------------------------------------------------------

async function requireOwner(userId: string) {
  const owner = await db
    .selectFrom("users")
    .select(["id", "email", "metadata", "default_currency", "is_ghost"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  return owner;
}

/**
 * Records the importer's own Splitwise id so their rows resolve to themselves.
 *
 * Skipped when the id is already taken by another local row; that means two
 * accounts here are importing the same Splitwise account, and silently moving
 * the id between them would be worse than leaving it where it is.
 */
async function stampOwnerSplitwiseId(userId: string, splitwiseId: number): Promise<void> {
  const owner = await db
    .selectFrom("users")
    .select(["id", "metadata"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!owner || splitwiseIdOf(owner.metadata) !== null) return;

  await db
    .updateTable("users")
    .set({ metadata: metadataWithSplitwiseId(owner.metadata, splitwiseId) })
    .where("id", "=", userId)
    .where(splitwiseIdSql(), "is", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("users as other").select("other.id").where(splitwiseIdSql("other"), "=", splitwiseId),
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

async function loadGroupMap(): Promise<Map<number, string>> {
  const rows = await db
    .selectFrom("groups")
    .select(["id", "metadata"])
    .where(splitwiseIdSql(), "is not", null)
    .where("deleted_at", "is", null)
    .execute();
  const map = new Map<number, string>();
  for (const r of rows) {
    const id = splitwiseIdOf(r.metadata);
    if (id != null) map.set(id, r.id);
  }
  return map;
}

async function findGroupsBySplitwiseIds(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .selectFrom("groups")
    .select("metadata")
    .where(splitwiseIdSql(), "in", ids)
    .execute();
  return new Set(rows.map((r) => splitwiseIdOf(r.metadata)).filter((id): id is number => id != null));
}

/** Splitwise ISO timestamps → ULID millis. Missing or junk falls through to `Date.now()`. */
function millisFromIso(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/**
 * One instant for both the ULID and `created_at`, so they cannot disagree.
 * First parseable candidate wins; otherwise now.
 */
function originalInstant(
  ...candidates: Array<string | null | undefined>
): { id: string; createdAt: string } {
  const ms = candidates.map(millisFromIso).find((n) => n != null) ?? Date.now();
  return { id: ulid(ms), createdAt: new Date(ms).toISOString() };
}

export type { SplitwiseGroup };
