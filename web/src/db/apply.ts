/**
 * Writing sync payloads into the mirror.
 *
 * Every path that puts server data into Dexie goes through here - bootstrap,
 * pull, snapshot, and the write-through the online API calls do - so there is one
 * answer to "what does storing an expense mean" rather than four.
 *
 * These functions are deliberately dumb: they store what they are given. The
 * POLICY about whether a remote row may overwrite a local one lives in
 * web/src/sync/engine.ts, which knows about the outbox; mixing the two here is
 * how a pending edit ends up silently replaced by the version it was based on.
 * The one exception is `syncState`, set to `synced` on anything that arrived from
 * the server, because that is a property of where the row came from and not a
 * decision.
 *
 * Nested users are unpacked at every opportunity. A payload carries the people it
 * names (docs/OFFLINE.md) precisely so a bill from a stranger renders with a name
 * instead of a blank, and the cost of missing one is a screen that looks broken.
 */
import type {
  LocalDb,
  LocalExpense,
  SyncCategory,
  SyncComment,
  SyncCurrency,
  SyncExpense,
  SyncFriendship,
  SyncGroup,
  SyncGroupMember,
  SyncUser,
} from "./local.ts";
import { friendshipKey, memberKey, setMeta } from "./local.ts";
import { remapPayloadUser } from "./remap.ts";

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * Stores user records, newest wins.
 *
 * A retired ghost (`mergedIntoUserId` set) is stored rather than dropped: an old
 * expense may still name it if a merge log row went astray, and a stub with a
 * name beats a blank. `applyUserMerge` below is what actually removes it.
 */
export async function putUsers(db: LocalDb, users: SyncUser[]): Promise<void> {
  if (users.length === 0) return;
  await db.users.bulkPut(users);
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------

/**
 * Stores expenses as the server's own copy, plus the people they name.
 *
 * Clears `conflictWith` and `rejectedReason`: whatever the local divergence was,
 * this row is now what the server says, and leaving the old server snapshot
 * attached would keep a resolved conflict on the screen forever.
 */
export async function putExpenses(db: LocalDb, expenses: SyncExpense[]): Promise<void> {
  if (expenses.length === 0) return;

  await putUsers(
    db,
    expenses.flatMap((e) => e.people),
  );

  const rows: LocalExpense[] = expenses.map((expense) => ({
    ...expense,
    syncState: "synced",
    conflictWith: null,
    rejectedReason: null,
  }));

  await db.expenses.bulkPut(rows);
}

/**
 * Marks an expense's local row without touching what the server said.
 *
 * Used when a write is queued (`pending`), refused (`rejected`) or overtaken
 * (`conflict`). A no-op if the expense is not in the mirror, which is the case
 * for an op the user queued and then the row was forgotten under them.
 */
export async function markExpense(
  db: LocalDb,
  id: string,
  patch: Partial<Pick<LocalExpense, "syncState" | "conflictWith" | "rejectedReason">>,
): Promise<void> {
  const existing = await db.expenses.get(id);
  if (!existing) return;
  await db.expenses.put({ ...existing, ...patch });
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export async function putComments(db: LocalDb, comments: SyncComment[]): Promise<void> {
  if (comments.length === 0) return;

  await putUsers(
    db,
    comments.map((c) => c.author).filter((a): a is SyncUser => a !== null),
  );

  await db.comments.bulkPut(comments.map((comment) => ({ ...comment, syncState: "synced" })));
}

// ---------------------------------------------------------------------------
// Groups, members, friendships
// ---------------------------------------------------------------------------

export async function putGroups(db: LocalDb, groups: SyncGroup[]): Promise<void> {
  if (groups.length === 0) return;
  await db.groups.bulkPut(groups);
}

export async function putGroupMembers(
  db: LocalDb,
  members: SyncGroupMember[],
): Promise<void> {
  if (members.length === 0) return;

  await putUsers(
    db,
    members.map((m) => m.user).filter((u): u is SyncUser => u !== null),
  );

  await db.groupMembers.bulkPut(
    members.map((member) => ({ ...member, key: memberKey(member.groupId, member.userId) })),
  );
}

export async function putFriendships(
  db: LocalDb,
  friendships: SyncFriendship[],
): Promise<void> {
  if (friendships.length === 0) return;

  await putUsers(
    db,
    friendships.map((f) => f.otherUser).filter((u): u is SyncUser => u !== null),
  );

  await db.friendships.bulkPut(
    friendships.map((f) => ({ ...f, key: friendshipKey(f.userAId, f.userBId) })),
  );
}

/** A friendship that has been removed. The people stay; only the pair goes. */
export async function dropFriendship(
  db: LocalDb,
  userAId: string,
  userBId: string,
): Promise<void> {
  await db.friendships.delete(friendshipKey(userAId, userBId));
}

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

/**
 * Currencies and categories.
 *
 * Not an optimisation. `web/src/money.tsx` refuses to render an amount without
 * its currency's decimal places - on purpose, since defaulting to 2 is how JPY
 * shows at a hundredth of its value - so a mirror with expenses and no currencies
 * is a screen of dashes.
 */
export async function putReferenceData(
  db: LocalDb,
  data: { currencies?: SyncCurrency[]; categories?: SyncCategory[] },
): Promise<void> {
  if (data.currencies?.length) await db.currencies.bulkPut(data.currencies);
  if (data.categories?.length) await db.categories.bulkPut(data.categories);
}

// ---------------------------------------------------------------------------
// Forgetting
// ---------------------------------------------------------------------------

/**
 * Drops a local expense entirely: the row, its thread, and anything queued for it.
 *
 * This is `forget`, not `delete`. A delete leaves a tombstone every device keeps
 * so the undo works from any of them; a forget means the caller may no longer see
 * this bill at all - they were removed from it, or it moved into a group they are
 * not in - and keeping a copy would leave it counting towards a balance they are
 * no longer part of.
 *
 * The outbox entries go too, and that is the point rather than tidiness: pushing
 * an edit for an expense you can no longer see would be rejected anyway, and a
 * quarantined op the user cannot act on is noise.
 */
export async function forgetExpense(db: LocalDb, expenseId: string): Promise<void> {
  await db.transaction("rw", db.expenses, db.comments, db.outbox, async () => {
    await db.expenses.delete(expenseId);

    const comments = await db.comments.where("expenseId").equals(expenseId).toArray();
    await db.comments.bulkDelete(comments.map((c) => c.id));

    const ids = new Set([expenseId, ...comments.map((c) => c.id)]);
    const queued = await db.outbox.toArray();
    await db.outbox.bulkDelete(
      queued.filter((op) => ids.has(op.id)).map((op) => op.seq!),
    );
  });
}

/**
 * Drops the group's expenses that the caller is not a participant of.
 *
 * Run when a `group_member` row for the caller arrives with `leftAt` set. The rule
 * is deliberately the same one the All Expenses screen has always used: leaving a
 * group hides the group, not the bills you are personally on. Somebody still owes
 * you for that dinner.
 */
export async function forgetGroupExpenses(
  db: LocalDb,
  groupId: string,
  selfUserId: string,
): Promise<void> {
  const expenses = await db.expenses.where("groupId").equals(groupId).toArray();
  for (const expense of expenses) {
    if (expense.shares.some((s) => s.userId === selfUserId)) continue;
    await forgetExpense(db, expense.id);
  }
}

// ---------------------------------------------------------------------------
// Claim / merge
// ---------------------------------------------------------------------------

/**
 * Applies a `user_merge`: the ghost `fromUserId` is now the account `toUserId`.
 *
 * Wipe-and-rebootstrap would be much simpler and is the wrong answer. It destroys
 * the outbox - the only copy of an unsynced dinner - along with conflict and
 * quarantine state, and it would fire on the *owner's* other laptop merely because
 * somebody else claimed a placeholder they created. So: remap.
 *
 * WHAT IS DELIBERATELY NOT REMAPPED IS `expenseUsers`. Rewriting a share's user id
 * would either duplicate the survivor on a bill both people were on, or keep the
 * pre-merge amounts on one they were not. Combining shares is `src/domain/merge.ts`'s
 * job and a second implementation in the browser would drift from it; the server
 * sends the rewritten expense as an ordinary upsert in the same pull page, and
 * replacing the whole document is what fixes those rows.
 *
 * Returns the outbox entries that could not be remapped cleanly, for the caller to
 * quarantine. That happens when a queued expense named BOTH people: the result
 * would be the survivor twice on one bill, whose paid and owed amounts only
 * `merge.ts` may add together. The user re-edits.
 */
export async function applyUserMerge(
  db: LocalDb,
  fromUserId: string,
  toUserId: string,
): Promise<number[]> {
  const unmappable: number[] = [];

  await db.transaction(
    "rw",
    db.users,
    db.groupMembers,
    db.friendships,
    db.comments,
    db.outbox,
    async () => {
      // Memberships: repoint, unless the survivor already has a row in that
      // group - then the survivor's row wins and the ghost's is dropped, exactly
      // as the server did.
      for (const member of await db.groupMembers.where("userId").equals(fromUserId).toArray()) {
        await db.groupMembers.delete(member.key);
        const survivorKey = memberKey(member.groupId, toUserId);
        if (await db.groupMembers.get(survivorKey)) continue;
        await db.groupMembers.put({ ...member, key: survivorKey, userId: toUserId });
      }

      // Friendships are stored canonically, so a repoint can collide with an
      // existing pair or become a self-friendship. Both are dropped rather than
      // repaired: "friends with yourself" means nothing, and a duplicate pair is
      // the same fact twice.
      for (const friendship of await db.friendships.toArray()) {
        if (friendship.userAId !== fromUserId && friendship.userBId !== fromUserId) continue;
        await db.friendships.delete(friendship.key);

        const other =
          friendship.userAId === fromUserId ? friendship.userBId : friendship.userAId;
        if (other === toUserId) continue;

        const [userAId, userBId] = toUserId < other ? [toUserId, other] : [other, toUserId];
        const key = friendshipKey(userAId, userBId);
        if (await db.friendships.get(key)) continue;
        await db.friendships.put({
          key,
          userAId,
          userBId,
          createdAt: friendship.createdAt,
          otherUser: (await db.users.get(other)) ?? null,
        });
      }

      for (const comment of await db.comments.toArray()) {
        if (comment.userId !== fromUserId) continue;
        await db.comments.put({
          ...comment,
          userId: toUserId,
          author: (await db.users.get(toUserId)) ?? comment.author,
        });
      }

      for (const op of await db.outbox.toArray()) {
        const remapped = remapPayloadUser(op.payload, fromUserId, toUserId);
        if (remapped === "collision") {
          unmappable.push(op.seq!);
          continue;
        }
        if (remapped === op.payload) continue;
        await db.outbox.put({ ...op, payload: remapped });
      }

      await db.users.delete(fromUserId);
    },
  );

  return unmappable;
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export interface BootstrapPage {
  seq: number;
  self?: SyncUser | null;
  groups?: SyncGroup[];
  members?: SyncGroupMember[];
  friendships?: SyncFriendship[];
  expenses?: SyncExpense[];
  comments?: SyncComment[];
  currencies?: SyncCurrency[];
  categories?: SyncCategory[];
  nextCursor: string | null;
}

/**
 * Applies one bootstrap page.
 *
 * The cursor is NOT advanced here. The caller keeps the `seq` from the FIRST page
 * and writes it once every page has drained - see web/src/sync/engine.ts for why
 * that direction of error is the safe one.
 */
export async function applyBootstrapPage(db: LocalDb, page: BootstrapPage): Promise<void> {
  if (page.self) {
    await putUsers(db, [page.self]);
    await setMeta(db, "profile", page.self);
  }
  await putReferenceData(db, page);
  await putGroups(db, page.groups ?? []);
  await putGroupMembers(db, page.members ?? []);
  await putFriendships(db, page.friendships ?? []);
  await putExpenses(db, page.expenses ?? []);
  await putComments(db, page.comments ?? []);
}
