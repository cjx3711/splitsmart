/**
 * Splitwise identity: matching and claiming imported placeholders.
 *
 * Groups and expenses are already unique on `metadata.splitwise_id`. People
 * are too, but the importer themselves can already exist as a ghost someone
 * else created. These helpers fold that ghost into a real account.
 *
 * Two proofs, and they are not interchangeable:
 *
 *   Splitwise API key   you are that Splitwise user. Merge any live ghost
 *                       carrying that splitwise_id, dummy or confirmed.
 *   Signup email        you typed an address. Only merge when Splitwise had
 *                       marked that person `confirmed` (a real Splitwise
 *                       account, not an email someone else typed). A dummy
 *                       still needs a guest link or their own later import.
 *
 * Manual invite ghosts have no splitwise_id and are never auto-claimed:
 * two owners can invite the same inbox, and that is not identity.
 */
import { db } from "../db/index.ts";
import { mergeUsers, MergeError, type MergeResult } from "./merge.ts";
import {
  metadataWithSplitwiseIdentity,
  splitwiseIdOf,
  splitwiseIdSql,
  splitwiseRegistrationStatusOf,
} from "./metadata.ts";

export interface AdoptedGhost {
  ghostId: string;
  name: string;
  merge: MergeResult;
}

/**
 * If a live placeholder already carries this Splitwise id, merge it into
 * `userId`, then stamp the id on the survivor.
 *
 * Called at the start of every import write. The API key is the proof; the
 * ghost's `registration_status` does not matter.
 */
export async function adoptImportedGhostBySplitwiseId(
  userId: string,
  splitwiseId: number,
  registrationStatus?: string | null,
): Promise<AdoptedGhost | null> {
  const ghost = await findLiveImportedGhostBySplitwiseId(splitwiseId);
  let adopted: AdoptedGhost | null = null;

  if (ghost && ghost.id !== userId) {
    const merge = await mergeUsers(ghost.id, userId);
    adopted = { ghostId: ghost.id, name: ghost.name, merge };
  }

  await stampUserSplitwiseIdentity(userId, splitwiseId, registrationStatus);
  return adopted;
}

/**
 * Signup path: a confirmed Splitwise person was imported as a placeholder at
 * this invite address. Exactly one match is identity; zero or two is not.
 */
export async function adoptConfirmedImportedGhostByEmail(
  userId: string,
  email: string,
): Promise<AdoptedGhost | null> {
  const ghosts = await db
    .selectFrom("users")
    .select(["id", "name", "metadata"])
    .where("is_ghost", "=", 1)
    .where("deleted_at", "is", null)
    .where("invite_email", "=", email)
    .where(splitwiseIdSql(), "is not", null)
    .execute();

  const confirmed = ghosts.filter(
    (row) => splitwiseRegistrationStatusOf(row.metadata) === "confirmed",
  );
  if (confirmed.length !== 1) return null;

  const ghost = confirmed[0]!;
  if (ghost.id === userId) return null;

  try {
    const merge = await mergeUsers(ghost.id, userId);
    return { ghostId: ghost.id, name: ghost.name, merge };
  } catch (err) {
    if (err instanceof MergeError) return null;
    throw err;
  }
}

export async function findLiveImportedGhostBySplitwiseId(splitwiseId: number) {
  return db
    .selectFrom("users")
    .select(["id", "name", "metadata"])
    .where(splitwiseIdSql(), "=", splitwiseId)
    .where("is_ghost", "=", 1)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
}

/**
 * Records the Splitwise id on this account so later lookups resolve here.
 *
 * No-op when another live row already holds the id: two real accounts
 * importing the same Splitwise user is not something we silently "fix".
 */
export async function stampUserSplitwiseIdentity(
  userId: string,
  splitwiseId: number,
  registrationStatus?: string | null,
): Promise<void> {
  const owner = await db
    .selectFrom("users")
    .select(["id", "metadata"])
    .where("id", "=", userId)
    .executeTakeFirst();
  if (!owner) return;

  const currentId = splitwiseIdOf(owner.metadata);
  if (currentId !== null && currentId !== splitwiseId) return;

  const taken = await db
    .selectFrom("users")
    .select("id")
    .where(splitwiseIdSql(), "=", splitwiseId)
    .where("id", "!=", userId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (taken) return;

  const next = metadataWithSplitwiseIdentity(owner.metadata, splitwiseId, registrationStatus);
  await db.updateTable("users").set({ metadata: next }).where("id", "=", userId).execute();
}
