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
 *    ULID - the original integer is not reused as `id`. Only when there is no
 *    id match do we fall back to matching an existing local account by email;
 *    that is the one heuristic in here, and the UI has to say so out loud
 *    before the user starts. The id is global: a friend's later import finds
 *    the same people, groups and expenses. If the importer themselves already
 *    exists as a ghost (someone else imported them first), that ghost is merged
 *    into their account before anything else is written.
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
 * 4. A BAD ROW IS SKIPPED, NEVER FUDGED — with one exception. Extra digits
 *    past the currency's scale (Splitwise sending `"197529.02"` for JPY) are
 *    dropped, a system comment is left on the bill, and the row is listed in
 *    `warnings[]` rather than `skipped[]`. Unknown currency, a group that has
 *    not been imported yet, shares that do not add up: those still skip. A
 *    later rounding step then matches Splitwise group member nets first, then
 *    friend totals, and records settle-ups for leftover cents so the books
 *    match per group and per friend.
 *
 * The API key never reaches this module as anything but a live client object,
 * and is never persisted. See src/splitwise/client.ts.
 */
import { db, transaction } from "../db/index.ts";
import { formatAmount, parseAmountRounded } from "./money.ts";
import type { Repayment } from "./split.ts";
import {
  createExpense,
  ExpenseError,
  importStamp,
  markImportSynced,
  resumeRepeat,
  updateExpense,
} from "./expenses.ts";
import {
  getGroupBalances,
  getPairwiseBalances,
  getPairwiseBalancesByGroup,
} from "./balances.ts";
import { simplifyDebts } from "./settle.ts";
import { isRepeatInterval, type RepeatInterval } from "./recurring.ts";
import { createComment } from "./comments.ts";
import { logChange } from "./sync-log.ts";
import {
  addFriendship,
  findExplicitGhostByInviteEmail,
  listRelatedUserIds,
} from "./friends.ts";
import { isUlid, ulid } from "./ulid.ts";
import {
  metadataFromSplitwise,
  parseMetadata,
  serializeMetadata,
  splitwiseIdOf,
  splitwiseIdSql,
  type EntityMetadata,
} from "./metadata.ts";
import {
  adoptImportedGhostBySplitwiseId,
  findLiveImportedGhostBySplitwiseId,
  stampUserSplitwiseIdentity,
} from "./splitwise-identity.ts";
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
  matchedBy: "splitwise_id" | "email" | "invite_email" | "self" | "created";
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

  constructor(
    ownerId: string,
    ownerSplitwiseId: number,
    defaultCurrency: string,
  ) {
    this.ownerId = ownerId;
    this.ownerSplitwiseId = ownerSplitwiseId;
    this.defaultCurrency = defaultCurrency;
  }

  /** The local account doing this import. Fallback author for platform notes. */
  importerId(): string {
    return this.ownerId;
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

    const byEmail = person.email
      ? await this.findByEmail(person.email)
      : undefined;
    if (byEmail) return this.describe(person, byEmail.id, "email");

    const byInvite = person.email
      ? await findExplicitGhostByInviteEmail(db, this.ownerId, person.email)
      : undefined;
    if (byInvite) return this.describe(person, byInvite.id, "invite_email");

    return this.describe(person, null, "created");
  }

  private async lookupOrCreate(person: SplitwiseUser): Promise<PersonResult> {
    if (person.id === this.ownerSplitwiseId) {
      return this.describe(person, this.ownerId, "self");
    }

    const byId = await this.findBySplitwiseId(person.id);
    if (byId) {
      await stampUserSplitwiseIdentity(
        byId.id,
        person.id,
        person.registration_status,
      );
      return this.describe(person, byId.id, "splitwise_id");
    }

    // The documented heuristic: someone who already has a SplitSmart account at
    // the address Splitwise knows them by IS that person. Stamping the
    // splitwise_id into metadata makes every later lookup an id match, so this
    // branch runs at most once per person per account.
    if (person.email) {
      const byEmail = await this.findByEmail(person.email);
      if (byEmail) {
        await stampUserSplitwiseIdentity(
          byEmail.id,
          person.id,
          person.registration_status,
        );
        return this.describe(person, byEmail.id, "email");
      }
    }

    if (person.email) {
      const byInvite = await findExplicitGhostByInviteEmail(
        db,
        this.ownerId,
        person.email,
      );
      if (byInvite) {
        await stampUserSplitwiseIdentity(
          byInvite.id,
          person.id,
          person.registration_status,
        );
        return this.describe(person, byInvite.id, "invite_email");
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
          metadata: metadataFromSplitwise(
            person.id,
            person.registration_status,
          ),
          name: splitwiseDisplayName(person),
          // Invite address only. Occupying users.email would squat the login
          // unique index and block this person from registering.
          invite_email: person.email ?? null,
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
      name: splitwiseDisplayName(person),
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
    return (
      db
        .selectFrom("users")
        .select(["id", "metadata"])
        // users.email is COLLATE NOCASE, so this is already case-insensitive.
        // Ghosts store their invite address in invite_email and must not match
        // here: that would treat a placeholder as an existing account.
        .where("email", "=", email)
        .where("is_ghost", "=", 0)
        .where("deleted_at", "is", null)
        .executeTakeFirst()
    );
  }
}

/** Splitwise allows a blank first name; the column does not. */
function splitwiseDisplayName(person: SplitwiseUser): string {
  const first = person.first_name?.trim();
  const last = person.last_name?.trim();
  const joined = [first, last].filter(Boolean).join(" ");
  if (joined) return joined;
  return person.email?.split("@")[0] ?? `Splitwise user ${person.id}`;
}

function localId(person: PersonResult): string {
  if (person.localUserId === null) {
    throw new Error(
      `Splitwise user ${person.splitwiseId} was not resolved to a local account`,
    );
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
  groups: Array<{
    splitwiseId: number;
    name: string;
    members: number;
    alreadyImported: boolean;
  }>;
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

  const [swGroups, swFriends, expenseCount, local, firstPage, decimalsByCurrency] =
    await Promise.all([
      client.getGroups(),
      client.getFriends(),
      client.countExpenses(),
      localFootprint(userId),
      // One page, purely to see what Splitwise says about comments, recurrence and
      // receipts. The warnings below are the whole reason: a wizard that mentions
      // these only afterwards is a wizard that surprised you.
      client.getExpenses({ limit: 100, offset: 0 }),
      loadCurrencyDecimals(),
    ]);

  const resolver = new PersonResolver(userId, swMe.id, owner.default_currency);
  const people: PersonResult[] = [];
  const seen = new Set<number>();

  for (const person of [
    ...swFriends,
    ...swGroups.flatMap((g) => g.members ?? []),
  ]) {
    if (person.id === swMe.id || seen.has(person.id)) continue;
    seen.add(person.id);
    people.push(await resolver.plan(person));
  }

  const importable = swGroups.filter((g) => g.id !== NON_GROUP_ID);
  const existingGroups = await findGroupsBySplitwiseIds(
    importable.map((g) => g.id),
  );

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
    "People are matched to existing SplitSmart accounts by Splitwise id, then by email address. " +
      (byEmail.length > 0
        ? `${byEmail.length} of your Splitwise contacts match an existing account this way ` +
          `(${byEmail.map((p) => p.name).join(", ")}). Anyone whose Splitwise email differs ` +
          `from their SplitSmart email will be imported as a separate placeholder person.`
        : "None of your Splitwise contacts match an existing account, so they will all be " +
          "imported as placeholder people you can invite later."),
  );

  const selfGhost = await findLiveImportedGhostBySplitwiseId(swMe.id);
  if (selfGhost && selfGhost.id !== userId) {
    warnings.push(
      `You already exist here as a placeholder (${selfGhost.name}) from someone else's ` +
        `Splitwise import. Importing will merge that history into this account.`,
    );
  }

  if (
    swMe.email &&
    owner.email &&
    swMe.email.toLowerCase() !== owner.email.toLowerCase()
  ) {
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

  const commentCount = firstPage.reduce(
    (sum, e) => sum + (e.comments_count ?? 0),
    0,
  );
  if (commentCount > 0) {
    warnings.push(
      "Comments are imported as well. This includes both user comments and the automatic ones which indicate change history.",
    );
  }

  // Land as stopped series, not live templates. Arming the scheduler here
  // would start generating bills this account never asked us to originate.
  // The wizard offers to continue them after import. See docs/PARITY.md slice 2.
  if (firstPage.some((e) => e.repeats === true)) {
    warnings.push(
      "Recurring expenses come across as stopped series. Nothing is scheduled until you " +
        "choose to continue them after import. Continuing starts from today and does not " +
        "create months that already happened.",
    );
  }

  // One warning, not a skip per expense: a receipt image is not part of the
  // ledger, and refusing the whole bill over it would be absurd.
  if (firstPage.some((e) => e.receipt?.original || e.receipt?.large)) {
    warnings.push(
      "Receipt images are not imported. This app has no file storage at all, by design.",
    );
  }

  let roundedOnFirstPage = 0;
  for (const expense of firstPage) {
    if (expense.deleted_at) continue;
    const decimals = decimalsByCurrency.get((expense.currency_code ?? "").toUpperCase());
    if (decimals === undefined) continue;
    try {
      if (parseAmountRounded(String(expense.cost ?? "0"), decimals).adjustment) {
        roundedOnFirstPage++;
      }
    } catch {
      // Invalid amount; the expenses step will skip it.
    }
  }
  if (roundedOnFirstPage > 0) {
    warnings.push(
      `At least ${roundedOnFirstPage} expense(s) use more decimal places than their currency allows. ` +
        `Extra digits will be dropped and a note added to each bill. After import, ` +
        `leftover cents between these books and Splitwise friend totals are offset with a settle-up.`,
    );
  }

  return {
    splitwiseAccount: {
      id: swMe.id,
      name: splitwiseDisplayName(swMe),
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
  await adoptImportedGhostBySplitwiseId(
    userId,
    swMe.id,
    swMe.registration_status,
  );

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
  await adoptImportedGhostBySplitwiseId(
    userId,
    swMe.id,
    swMe.registration_status,
  );

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
          const created = await trx
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

          // Without this, an already-synced device never learns the group's
          // name or that it exists: expenses reach it through their own
          // sync-log rows, but the group document does not, and friend/group
          // screens render a bare id instead of a name.
          await logChange(trx, {
            entity: "group",
            entityId: created.id,
            groupId: created.id,
            actorUserId: userId,
          });

          return created;
        })
      ).id;

    // The importer is always a member, even if Splitwise's member list is
    // stale; otherwise they cannot see the group they just imported.
    let membersAdded = (await ensureMember(localGroupId, userId, "creator"))
      ? 1
      : 0;

    for (const member of swGroup.members ?? []) {
      if (member.id === swMe.id) continue;
      const person = await resolver.resolve(member);
      if (await ensureMember(localGroupId, localId(person), "import"))
        membersAdded++;
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
    await logChange(db, {
      entity: "group_member",
      entityId: userId,
      groupId,
      actorUserId: userId,
    });
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
  // Same reason as the group's own logChange above: membership has to reach
  // an already-synced device on its own, not only at fresh bootstrap.
  await logChange(db, {
    entity: "group_member",
    entityId: userId,
    groupId,
    actorUserId: userId,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Step 3: expenses
// ---------------------------------------------------------------------------

export interface PausedImportedSeries {
  id: string;
  description: string;
  date: string;
  interval: RepeatInterval;
  currencyCode: string;
  costMinor: number;
  /** Display names of everyone on the bill. The importer is labelled "You". */
  participants: string[];
}

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
  /**
   * Imported, but not byte-for-byte: extra digits past the currency's scale were
   * dropped. A system comment is on the bill. Not a skip.
   */
  warnings: SkippedRow[];
  /**
   * Newly imported Splitwise repeating expenses, landed as stopped series.
   * Already-present rows are omitted: the user already had a chance, and can
   * still resume from the expense page.
   */
  pausedSeries: PausedImportedSeries[];
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
  await adoptImportedGhostBySplitwiseId(
    userId,
    swMe.id,
    swMe.registration_status,
  );

  const offset = params.offset ?? 0;
  const limit = params.limit ?? 100;

  const page = await client.getExpenses({ limit, offset });
  const resolver = new PersonResolver(userId, swMe.id, owner.default_currency);

  const [decimalsByCurrency, categoryIds, groupIdBySplitwiseId] =
    await Promise.all([
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
    warnings: [],
    pausedSeries: [],
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
      if (outcome.status === "imported") {
        result.imported++;
        if (outcome.pausedSeries) result.pausedSeries.push(outcome.pausedSeries);
      } else if (outcome.status === "refreshed") result.refreshed++;
      else if (outcome.status === "present") result.alreadyPresent++;
      result.commentsImported += outcome.commentsImported;
      result.skipped.push(...outcome.skippedComments);
      result.warnings.push(...outcome.warnings);
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
  warnings: SkippedRow[];
  pausedSeries?: PausedImportedSeries;
}

/** Throws with a human-readable reason; the caller turns that into a skip. */
async function importOneExpense(
  swExpense: SplitwiseExpense,
  ctx: ExpenseContext,
): Promise<ExpenseOutcome> {
  const existing = await db
    .selectFrom("expenses")
    .select([
      "id",
      "created_at",
      "updated_at",
      "metadata",
      "description",
      "details",
      "cost_minor",
      "currency_code",
      "date",
      "category_id",
      "is_payment",
      "group_id",
    ])
    .where(splitwiseIdSql(), "=", swExpense.id)
    .executeTakeFirst();

  // A tombstone in Splitwise affects nobody's balance. Importing it would mean
  // writing a row purely to soft-delete it, so it is left behind on purpose. A
  // row deleted in Splitwise AFTER we imported it is left alone rather than
  // deleted here: that is somebody's balance, and this is an import, not a sync.
  if (swExpense.deleted_at) {
    if (existing)
      return { status: "present", commentsImported: 0, skippedComments: [], warnings: [] };
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
      throw new Error(
        `Group ${swGroupId} has not been imported; run the groups step first`,
      );
    }
  }

  const swUsers = swExpense.users ?? [];
  if (swUsers.length === 0) throw new Error("Expense has no participants");

  const cost = parseAmountRounded(String(swExpense.cost ?? "0"), decimals);
  let adjustment = cost.adjustment;

  const participants: Array<{
    userId: string;
    paidMinor: number;
    input: number;
  }> = [];
  const participantNames: string[] = [];
  // Splitwise ids are what `repayments[]` refers to; the local ids are ULIDs.
  const localIdBySplitwiseId = new Map<number, string>();
  for (const share of swUsers) {
    const person = share.user ?? (share.user_id ? { id: share.user_id } : null);
    if (!person?.id) throw new Error("Participant with no user id");

    const resolved = await ctx.resolver.resolve(person as SplitwiseUser);
    const paid = parseAmountRounded(String(share.paid_share ?? "0"), decimals);
    const owed = parseAmountRounded(String(share.owed_share ?? "0"), decimals);
    adjustment ??= paid.adjustment ?? owed.adjustment;
    const userId = localId(resolved);
    localIdBySplitwiseId.set(person.id, userId);
    participants.push({
      userId,
      paidMinor: paid.minor,
      // Splitwise's own owed_share, imported as an `exact` split. Re-deriving
      // it from a split type would move cents, and cents are balances.
      input: owed.minor,
    });
    participantNames.push(userId === ctx.userId ? "You" : resolved.name);
  }

  // Rounding each share independently can leave paid/owed a yen either side of
  // the cost. Nudge the largest share so the invariant still holds; without a
  // rounding we leave a mismatch for createExpense to reject, which is the skip
  // path.
  if (adjustment) applyRoundingRemainder(cost.minor, participants);

  const repayments = mapRepayments(swExpense, localIdBySplitwiseId, decimals);

  const costMinor = cost.minor;

  // Splitwise lets someone leave a group while their expenses stay behind.
  // createExpense rejects non-members, so put them back rather than dropping
  // the expense; a missing expense expense is a wrong balance.
  if (groupId !== null) {
    for (const p of participants)
      await ensureMember(groupId, p.userId, "import");
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
    // Splitwise's own pairing, as a hint. Only the pairing: the amounts still
    // come from `participants`, and `deriveRepayments` clamps each hint to what
    // those shares support, so a refresh cannot import a contradiction.
    repayments,
  };

  if (existing) {
    const status = await refreshExpense(
      existing,
      fields,
      swExpense,
      ctx.userId,
    );
    const comments = await importNestedComments(existing.id, swExpense, ctx);
    return { status, ...comments, warnings: [] };
  }

  const { id, createdAt } = originalInstant(
    swExpense.created_at,
    swExpense.date,
  );
  const pausedInterval = splitwiseRepeatInterval(swExpense);
  const localId_ = await createExpense({
    ...fields,
    id,
    createdAt,
    metadata: {
      splitwise_id: swExpense.id,
      // Stopped, not live: `repeat_interval` stays null so the scheduler
      // cannot fire. Resume reads this the same way a hand-stopped series does.
      ...(pausedInterval ? { repeat_paused: pausedInterval } : {}),
    },
    createdBy: ctx.userId,
    // One activity row per expense would bury the feed under an import. The
    // route writes a single summary entry instead.
    recordActivity: false,
  });

  const comments = await importNestedComments(localId_, swExpense, ctx);
  const warnings: SkippedRow[] = [];
  if (adjustment) {
    const warning = await noteRounding({
      expenseId: localId_,
      importerId: ctx.userId,
      splitwiseId: swExpense.id,
      description: fields.description,
      adjustment,
      currency,
    });
    warnings.push(warning);
  }
  return {
    status: "imported",
    ...comments,
    warnings,
    ...(pausedInterval
      ? {
          pausedSeries: {
            id: localId_,
            description: fields.description,
            date: fields.date,
            interval: pausedInterval,
            currencyCode: fields.currencyCode,
            costMinor: fields.costMinor,
            participants: participantNames,
          },
        }
      : {}),
  };
}

/** Splitwise's interval names match ours; anything else is not a series here. */
function splitwiseRepeatInterval(sw: SplitwiseExpense): RepeatInterval | null {
  if (sw.repeats !== true) return null;
  const raw = (sw.repeat_interval ?? "").trim().toLowerCase();
  return isRepeatInterval(raw) ? raw : null;
}

/**
 * Independent truncation can leave paid/owed a few minor units off the cost.
 * Put the leftover on the largest share (ties: earliest userId) so the
 * invariant still holds. Does nothing if a bump would go negative: createExpense
 * then rejects, and the row stays a skip.
 */
/**
 * Splitwise's `repayments[]`, translated to local user ids.
 *
 * Anything unrecognisable is dropped rather than guessed at: this is a hint to
 * `deriveRepayments`, which fills whatever the hint does not cover, so a partial
 * or empty result is merely the old behaviour for that expense. A participant
 * Splitwise names in `repayments` but not in `users` cannot be resolved to a
 * share, so it has no local id and is skipped here.
 */
function mapRepayments(
  swExpense: SplitwiseExpense,
  localIdBySplitwiseId: Map<number, string>,
  decimals: number,
): Repayment[] {
  const out: Repayment[] = [];
  for (const r of swExpense.repayments ?? []) {
    const fromUserId = localIdBySplitwiseId.get(r.from);
    const toUserId = localIdBySplitwiseId.get(r.to);
    if (!fromUserId || !toUserId || fromUserId === toUserId) continue;
    let amountMinor: number;
    try {
      amountMinor = parseAmountRounded(String(r.amount ?? "0"), decimals).minor;
    } catch {
      continue;
    }
    if (amountMinor <= 0) continue;
    out.push({ fromUserId, toUserId, amountMinor });
  }
  return out;
}

function applyRoundingRemainder(
  costMinor: number,
  participants: Array<{ userId: string; paidMinor: number; input: number }>,
): void {
  const paidSum = participants.reduce((sum, p) => sum + p.paidMinor, 0);
  const owedSum = participants.reduce((sum, p) => sum + p.input, 0);
  bumpLargest(participants, "paidMinor", costMinor - paidSum);
  bumpLargest(participants, "input", costMinor - owedSum);
}

function bumpLargest(
  participants: Array<{ userId: string; paidMinor: number; input: number }>,
  field: "paidMinor" | "input",
  remainder: number,
): void {
  if (remainder === 0 || participants.length === 0) return;
  const target = [...participants]
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
    .reduce((best, p) => (p[field] > best[field] ? p : best));
  if (target[field] + remainder < 0) return;
  target[field] += remainder;
}

/**
 * System note on the bill plus a row for the wizard. Best-effort on the
 * comment: the expense has already landed, and failing the footnote must not
 * report a skip for a row that was written.
 */
async function noteRounding(input: {
  expenseId: string;
  importerId: string;
  splitwiseId: number;
  description: string;
  adjustment: string;
  currency: string;
}): Promise<SkippedRow> {
  const reason =
    `Fractional amount rounded by ${input.adjustment} ${input.currency} on import`;
  try {
    await createComment({
      expenseId: input.expenseId,
      userId: input.importerId,
      content: `${reason}.`,
      kind: "system",
      recordActivity: false,
      enforceVisibility: false,
    });
  } catch (err) {
    console.error(
      `Could not record a rounding comment on expense ${input.expenseId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  return {
    splitwiseId: input.splitwiseId,
    description: input.description,
    reason,
  };
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
 * The split stays `exact` either way - see rule 3's note in this module's header.
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
    throw new Error(
      "Changed in Splitwise, but edited here since import: local edits, not refreshed",
    );
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
// Continue imported series
// ---------------------------------------------------------------------------

export interface ContinueRecurringResult {
  continued: string[];
  skipped: Array<{ id: string; reason: string }>;
}

/**
 * Resume stopped series the importer landed. Same resume as the expense page:
 * starts from today, does not backfill. Unknown, unseen, or already-ordinary
 * ids are skipped rather than failing the batch.
 */
export async function continueImportedRepeats(
  userId: string,
  ids: string[],
): Promise<ContinueRecurringResult> {
  const continued: string[] = [];
  const skipped: ContinueRecurringResult["skipped"] = [];
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);

    if (!isUlid(id)) {
      skipped.push({ id, reason: "Invalid id" });
      continue;
    }

    const onIt = await db
      .selectFrom("expense_users")
      .select("user_id")
      .where("expense_id", "=", id)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!onIt) {
      skipped.push({ id, reason: "Not found" });
      continue;
    }

    try {
      const outcome = await resumeRepeat(id, userId);
      if (outcome === "resumed" || outcome === "already_live") continued.push(id);
    } catch (err) {
      skipped.push({
        id,
        reason: err instanceof ExpenseError ? err.message : String(err),
      });
    }
  }

  return { continued, skipped };
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

/** Bumped when previously skipped comments become importable. Missing is rev 1. */
const COMMENTS_IMPORT_REV = 2;

function commentsSyncedPatch(count: number): EntityMetadata {
  return {
    splitwise_comments_synced_at: new Date().toISOString(),
    splitwise_comments_count: count,
    splitwise_comments_import_rev: COMMENTS_IMPORT_REV,
  };
}

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
  /**
   * How many live imported expenses this step will walk. The wizard uses it as
   * the comments-phase total so the bar is "3250 of 3250", not the preview's
   * capped "~5000".
   */
  total: number;
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
  await adoptImportedGhostBySplitwiseId(
    userId,
    swMe.id,
    swMe.registration_status,
  );

  const offset = params.offset ?? 0;
  const limit = params.limit ?? 25;

  const resolver = new PersonResolver(userId, swMe.id, owner.default_currency);

  const [candidates, totalRow] = await Promise.all([
    db
      .selectFrom("expenses")
      .select(["id", "metadata", "description"])
      .where(splitwiseIdSql(), "is not", null)
      .where("deleted_at", "is", null)
      .orderBy("id")
      .limit(limit)
      .offset(offset)
      .execute(),
    db
      .selectFrom("expenses")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .where(splitwiseIdSql(), "is not", null)
      .where("deleted_at", "is", null)
      .executeTakeFirstOrThrow(),
  ]);

  const result: CommentsPageResult = {
    offset,
    scanned: candidates.length,
    fetched: 0,
    imported: 0,
    alreadyPresent: 0,
    skipped: [],
    total: Number(totalRow.n),
    nextOffset: candidates.length === 0 ? null : offset + candidates.length,
    done: candidates.length < limit,
  };

  for (const expense of candidates) {
    const meta = parseMetadata(expense.metadata);
    const swId = splitwiseIdOf(expense.metadata);
    if (swId === null) continue;

    // Already fetched at the current rule revision. An older stamp (no rev, or
    // a lower one) is re-fetched once so comments an earlier pass dropped —
    // platform notes with `user: null` — can land. Then it stays cheap.
    if (
      typeof meta.splitwise_comments_synced_at === "string" &&
      meta.splitwise_comments_import_rev === COMMENTS_IMPORT_REV
    ) {
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

      await markImportSynced(expense.id, commentsSyncedPatch(swComments.length));
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
 * Compare Splitwise balances with ours and record settle-ups for leftover cents.
 *
 * Truncation (and the remainder bump that keeps paid/owed summing to the cost)
 * can leave a group, or a friend total, a few minor units away from Splitwise.
 * This step writes a payment for any gap of at most `MAX_ROUNDING_MINOR`.
 * Larger gaps are skipped: those are skipped expenses or real drift, not
 * dropped fractions, and must not be papered over.
 *
 * Groups first. `get_groups` includes each member's net, so a group Splitwise
 * says is settled can be settled here too — including a 1-yen residue between
 * two other people that the importer is not on. Friend totals run after, and
 * only see what is still left (almost always the one-on-one bucket). Doing
 * friends first would park a group residue as a phantom one-on-one payment
 * that cancels in aggregate and looks wrong per group.
 *
 * Re-running is a no-op once the totals match. The payments carry no
 * `splitwise_id`, so a later expense refresh cannot treat them as upstream rows.
 */
const MAX_ROUNDING_MINOR = 100;

export interface RoundingTransfer {
  expenseId: string;
  friendId: string;
  friendName: string;
  currencyCode: string;
  amountMinor: number;
  fromUserId: string;
  toUserId: string;
  /** Which group's residue this settles, or null for the one-on-one bucket. */
  groupId: string | null;
  groupName?: string | null;
}

export interface RoundingSkip {
  splitwiseId: number;
  name: string;
  currencyCode: string | null;
  reason: string;
}

export interface RoundingResult {
  created: RoundingTransfer[];
  skipped: RoundingSkip[];
}

export async function reconcileImportedBalances(
  client: SplitwiseClient,
  userId: string,
): Promise<RoundingResult> {
  const [swFriends, swGroups] = await Promise.all([client.getFriends(), client.getGroups()]);
  const [decimals, localBySw, groupBySw] = await Promise.all([
    loadCurrencyDecimals(),
    loadUsersBySplitwiseId(),
    loadGroupMap(),
  ]);

  const created: RoundingTransfer[] = [];
  const skipped: RoundingSkip[] = [];

  await reconcileGroupResidues({
    userId,
    swGroups,
    decimals,
    localBySw,
    groupBySw,
    created,
    skipped,
  });

  // Friend totals after the group payments, so one-on-one only sees residue
  // that is actually one-on-one (or a group we could not settle).
  const [ours, byGroup] = await Promise.all([
    getPairwiseBalances(db, userId),
    getPairwiseBalancesByGroup(db, userId),
  ]);
  await reconcileFriendResidues({
    userId,
    swFriends,
    decimals,
    localBySw,
    ours,
    byGroup,
    created,
    skipped,
  });

  return { created, skipped };
}

async function reconcileGroupResidues(input: {
  userId: string;
  swGroups: SplitwiseGroup[];
  decimals: Map<string, number>;
  localBySw: Map<number, { id: string; name: string }>;
  groupBySw: Map<number, string>;
  created: RoundingTransfer[];
  skipped: RoundingSkip[];
}): Promise<void> {
  for (const swGroup of input.swGroups) {
    if (swGroup.id === NON_GROUP_ID) continue;

    const members = swGroup.members ?? [];
    // No `balance` key at all means this payload did not include group nets
    // (the test fake, an older dump). Do not treat that as "everyone is zero".
    if (!members.some((m) => m.balance !== undefined && m.balance !== null)) continue;

    const groupId = input.groupBySw.get(swGroup.id);
    if (!groupId) {
      input.skipped.push({
        splitwiseId: swGroup.id,
        name: swGroup.name,
        currencyCode: null,
        reason: "Group not imported yet; run the groups step first",
      });
      continue;
    }

    const ours = await getGroupBalances(db, groupId);
    const ourByUser = new Map(
      ours.map((row) => [row.userId, new Map(row.balances.map((b) => [b.currencyCode, b.amountMinor]))]),
    );

    const residualByUser = new Map<string, Map<string, number>>();
    const addResidual = (userId: string, currency: string, amount: number) => {
      if (amount === 0) return;
      const byCurrency = residualByUser.get(userId) ?? new Map<string, number>();
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + amount);
      residualByUser.set(userId, byCurrency);
    };

    for (const member of members) {
      if (member.balance === undefined || member.balance === null) continue;
      const local = input.localBySw.get(member.id);
      if (!local) continue;

      const swByCurrency = parseSplitwiseAmounts(
        member.balance,
        input.decimals,
        (code, reason) => {
          input.skipped.push({
            splitwiseId: member.id,
            name: `${swGroup.name} · ${local.name}`,
            currencyCode: code,
            reason,
          });
        },
      );

      const currencies = new Set([
        ...(ourByUser.get(local.id)?.keys() ?? []),
        ...swByCurrency.keys(),
      ]);
      for (const currency of currencies) {
        const ourMinor = ourByUser.get(local.id)?.get(currency) ?? 0;
        const swMinor = swByCurrency.get(currency) ?? 0;
        addResidual(local.id, currency, ourMinor - swMinor);
      }
    }

    const currencies = new Set<string>();
    for (const byCurrency of residualByUser.values()) {
      for (const code of byCurrency.keys()) currencies.add(code);
    }

    for (const currency of [...currencies].sort()) {
      const places = input.decimals.get(currency);
      if (places === undefined) continue;

      const nets: Array<{ userId: string; amountMinor: number }> = [];
      for (const [userId, byCurrency] of residualByUser) {
        const amount = byCurrency.get(currency) ?? 0;
        if (amount !== 0) nets.push({ userId, amountMinor: amount });
      }
      if (nets.length === 0) continue;

      const total = nets.reduce((sum, n) => sum + n.amountMinor, 0);
      if (total !== 0) {
        input.skipped.push({
          splitwiseId: swGroup.id,
          name: swGroup.name,
          currencyCode: currency,
          reason: `Group ${currency} residue does not net to zero`,
        });
        continue;
      }

      if (nets.some((n) => Math.abs(n.amountMinor) > MAX_ROUNDING_MINOR)) {
        for (const n of nets) {
          if (Math.abs(n.amountMinor) <= MAX_ROUNDING_MINOR) continue;
          const who = [...input.localBySw.values()].find((u) => u.id === n.userId);
          input.skipped.push({
            splitwiseId: swGroup.id,
            name: `${swGroup.name} · ${who?.name ?? n.userId}`,
            currencyCode: currency,
            reason:
              `Difference of ${formatAmount(n.amountMinor, places)} ${currency} is larger than import rounding`,
          });
        }
        continue;
      }

      for (const transfer of simplifyDebts(nets)) {
        if (transfer.amountMinor <= 0) continue;
        const from = nameOf(input.localBySw, transfer.fromUserId);
        const to = nameOf(input.localBySw, transfer.toUserId);
        const counterpartId =
          transfer.fromUserId === input.userId ? transfer.toUserId : transfer.fromUserId;
        const counterpartName = counterpartId === transfer.fromUserId ? from : to;
        input.created.push(
          await writeRoundingPayment({
            actorUserId: input.userId,
            fromUserId: transfer.fromUserId,
            toUserId: transfer.toUserId,
            amount: transfer.amountMinor,
            currency,
            places,
            groupId,
            groupName: swGroup.name,
            friendId: counterpartId,
            friendName:
              transfer.fromUserId === input.userId || transfer.toUserId === input.userId
                ? counterpartName
                : `${from} → ${to}`,
            scope: "group",
          }),
        );
      }
    }
  }
}

async function reconcileFriendResidues(input: {
  userId: string;
  swFriends: SplitwiseUser[];
  decimals: Map<string, number>;
  localBySw: Map<number, { id: string; name: string }>;
  ours: Awaited<ReturnType<typeof getPairwiseBalances>>;
  byGroup: Awaited<ReturnType<typeof getPairwiseBalancesByGroup>>;
  created: RoundingTransfer[];
  skipped: RoundingSkip[];
}): Promise<void> {
  const oursByUser = new Map(input.ours.map((row) => [row.otherUserId, row.balances]));

  // After the group pass, a leftover friend-total gap with exactly one
  // unsettled shared group in that currency still belongs in that group.
  const groupCandidatesByUser = new Map<string, Map<string, string[]>>();
  for (const row of input.byGroup) {
    if (row.groupId === null) continue;
    const byCurrency = groupCandidatesByUser.get(row.otherUserId) ?? new Map<string, string[]>();
    for (const b of row.balances) {
      if (b.amountMinor === 0) continue;
      const list = byCurrency.get(b.currencyCode) ?? [];
      list.push(row.groupId);
      byCurrency.set(b.currencyCode, list);
    }
    groupCandidatesByUser.set(row.otherUserId, byCurrency);
  }

  for (const friend of input.swFriends) {
    const local = input.localBySw.get(friend.id);
    if (!local) {
      input.skipped.push({
        splitwiseId: friend.id,
        name: splitwiseDisplayName(friend),
        currencyCode: null,
        reason: "Not imported yet; run the friends step first",
      });
      continue;
    }

    const ourByCurrency = new Map(
      (oursByUser.get(local.id) ?? []).map((b) => [b.currencyCode, b.amountMinor]),
    );
    const swByCurrency = parseSplitwiseAmounts(
      friend.balance,
      input.decimals,
      (code, reason) => {
        input.skipped.push({
          splitwiseId: friend.id,
          name: local.name,
          currencyCode: code,
          reason,
        });
      },
    );

    const currencies = [...new Set([...ourByCurrency.keys(), ...swByCurrency.keys()])].sort();
    for (const currency of currencies) {
      const ourMinor = ourByCurrency.get(currency) ?? 0;
      const swMinor = swByCurrency.get(currency) ?? 0;
      const delta = ourMinor - swMinor;
      if (delta === 0) continue;

      const places = input.decimals.get(currency);
      if (places === undefined) {
        input.skipped.push({
          splitwiseId: friend.id,
          name: local.name,
          currencyCode: currency,
          reason: `Unknown currency ${currency}`,
        });
        continue;
      }

      if (Math.abs(delta) > MAX_ROUNDING_MINOR) {
        input.skipped.push({
          splitwiseId: friend.id,
          name: local.name,
          currencyCode: currency,
          reason:
            `Difference of ${formatAmount(delta, places)} ${currency} is larger than import rounding`,
        });
        continue;
      }

      // Positive delta: they owe us more here than on Splitwise, so they "pay"
      // us the residue. Negative: we owe them more here, so we pay them.
      const amount = Math.abs(delta);
      const fromUserId = delta > 0 ? local.id : input.userId;
      const toUserId = delta > 0 ? input.userId : local.id;
      const groupCandidates = groupCandidatesByUser.get(local.id)?.get(currency) ?? [];
      const groupId = groupCandidates.length === 1 ? groupCandidates[0]! : null;

      input.created.push(
        await writeRoundingPayment({
          actorUserId: input.userId,
          fromUserId,
          toUserId,
          amount,
          currency,
          places,
          groupId,
          friendId: local.id,
          friendName: local.name,
          scope: "friend",
        }),
      );
    }
  }
}

function parseSplitwiseAmounts(
  entries: Array<{ currency_code: string; amount: string }> | null | undefined,
  decimals: Map<string, number>,
  onSkip: (currencyCode: string | null, reason: string) => void,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of entries ?? []) {
    const code = (entry.currency_code ?? "").toUpperCase();
    if (!code) continue;
    const places = decimals.get(code);
    if (places === undefined) {
      onSkip(code, `Unknown currency ${code}`);
      continue;
    }
    try {
      out.set(code, parseAmountRounded(String(entry.amount ?? "0"), places).minor);
    } catch {
      onSkip(code, `Could not parse ${entry.amount} ${code}`);
    }
  }
  return out;
}

function nameOf(
  localBySw: Map<number, { id: string; name: string }>,
  userId: string,
): string {
  for (const row of localBySw.values()) {
    if (row.id === userId) return row.name;
  }
  return userId;
}

async function writeRoundingPayment(input: {
  actorUserId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  currency: string;
  places: number;
  groupId: string | null;
  groupName?: string;
  friendId: string;
  friendName: string;
  scope: "group" | "friend";
}): Promise<RoundingTransfer> {
  if (input.groupId !== null) {
    await ensureMember(input.groupId, input.fromUserId, "import");
    await ensureMember(input.groupId, input.toUserId, "import");
  }

  const expenseId = await createExpense({
    description: "Payment",
    details: "Offsets fractional amounts rounded off when importing from Splitwise.",
    costMinor: input.amount,
    currencyCode: input.currency,
    date: new Date().toISOString(),
    splitType: "exact",
    isPayment: true,
    groupId: input.groupId,
    metadata: { import_rounding: true },
    createdBy: input.actorUserId,
    recordActivity: false,
    participants: [
      { userId: input.fromUserId, paidMinor: input.amount, input: 0 },
      { userId: input.toUserId, paidMinor: 0, input: input.amount },
    ],
  });

  const where =
    input.scope === "group"
      ? `This payment restores the Splitwise totals in ${input.groupName ?? "the group"}.`
      : "This payment restores the Splitwise friend total.";

  try {
    await createComment({
      expenseId,
      userId: input.actorUserId,
      kind: "system",
      recordActivity: false,
      enforceVisibility: false,
      content:
        `Splitwise stored extra digits past what ${input.currency} allows. Those were rounded on ` +
        `import, which left this balance ${formatAmount(input.amount, input.places)} ${input.currency} ` +
        `away from Splitwise. ${where}`,
    });
  } catch (err) {
    console.error(
      `Could not record a rounding comment on expense ${expenseId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  return {
    expenseId,
    friendId: input.friendId,
    friendName: input.friendName,
    currencyCode: input.currency,
    amountMinor: input.amount,
    fromUserId: input.fromUserId,
    toUserId: input.toUserId,
    groupId: input.groupId,
    groupName: input.groupName ?? null,
  };
}

async function loadUsersBySplitwiseId(): Promise<Map<number, { id: string; name: string }>> {
  const rows = await db
    .selectFrom("users")
    .select(["id", "name", "metadata"])
    .where(splitwiseIdSql(), "is not", null)
    .where("deleted_at", "is", null)
    .execute();
  const map = new Map<number, { id: string; name: string }>();
  for (const row of rows) {
    const swId = splitwiseIdOf(row.metadata);
    if (swId != null) map.set(swId, { id: row.id, name: row.name });
  }
  return map;
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
      await markImportSynced(localExpenseId, {
        splitwise_comments_count: count,
      });
    }
    return { commentsImported: 0, skippedComments: [] };
  }

  let commentsImported = 0;
  const skippedComments: SkippedRow[] = [];

  for (const swComment of nested) {
    const outcome = await importComment(
      localExpenseId,
      swComment,
      ctx.resolver,
    );
    if (outcome.imported) commentsImported++;
    if (outcome.skipped) skippedComments.push(outcome.skipped);
  }

  await markImportSynced(localExpenseId, commentsSyncedPatch(nested.length));

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
 *   - no author at all (Splitwise's own "record a cash payment" notes, a
 *     deleted account) is kept as a system row attributed to the importer.
 *     The thread does not show a name on system comments, so this does not
 *     pretend the importer typed it. Dropping the row would throw the note away.
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
  if (content === "")
    return { imported: false, skipped: describe("Empty comment") };

  const existing = await db
    .selectFrom("comments")
    .select("id")
    .where(splitwiseIdSql("comments"), "=", swComment.id)
    .executeTakeFirst();
  if (existing) return { imported: false };

  const isSystem = (swComment.comment_type ?? "").toLowerCase() === "system";
  const author = swComment.user;
  const authorId = author?.id;
  const hasAuthor =
    typeof authorId === "number" && Number.isInteger(authorId) && authorId > 0;

  // Platform notes arrive with `user: null` (sometimes `id: 0`). The column is
  // NOT NULL, so the importer is the FK; kind is system so the UI does not
  // put anyone's name on a sentence Splitwise generated.
  const userId = hasAuthor
    ? localId(await resolver.resolve(author!))
    : resolver.importerId();

  const { id, createdAt } = originalInstant(swComment.created_at);

  await createComment({
    id,
    createdAt,
    expenseId: localExpenseId,
    userId,
    content,
    // Splitwise capitalises these: "User" / "System". Anything unrecognised is
    // treated as somebody having typed it, which is the safer default: it stays
    // deletable by its author rather than becoming permanent history. No author
    // is the exception: there is nobody who could delete it.
    kind: hasAuthor && !isSystem ? "user" : "system",
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

async function loadCurrencyDecimals(): Promise<Map<string, number>> {
  const rows = await db
    .selectFrom("currencies")
    .select(["code", "decimal_places"])
    .execute();
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
  return new Set(
    rows
      .map((r) => splitwiseIdOf(r.metadata))
      .filter((id): id is number => id != null),
  );
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
function originalInstant(...candidates: Array<string | null | undefined>): {
  id: string;
  createdAt: string;
} {
  const ms = candidates.map(millisFromIso).find((n) => n != null) ?? Date.now();
  return { id: ulid(ms), createdAt: new Date(ms).toISOString() };
}

export type { SplitwiseGroup };
