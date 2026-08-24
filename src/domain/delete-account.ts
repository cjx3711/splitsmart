/**
 * Delete this account.
 *
 * Two outcomes, picked by whether anyone else with a real login still shares
 * the ledger:
 *
 *   Other real accounts share groups or expenses
 *     Convert this row to a ghost. The history stays so their balances do not
 *     move. Email and password go; sessions and API tokens die. They become a
 *     placeholder the others can send a guest link for.
 *
 *   Nobody else has a real login on this data
 *     Wipe the ledger (same as "delete all data"), then retire the row so the
 *     email is free to register again.
 *
 * This does not write expense tables itself: the wipe path goes through
 * `wipeUserLedger`. Converting to a ghost only updates `users` plus credentials.
 */
import { transaction, type DB } from "../db/index.ts";
import { logChange } from "./sync-log.ts";
import {
  listSharingRealAccounts,
  wipeUserLedger,
  WipeBlockedError,
} from "./wipe.ts";

/** Must be typed into the second confirmation dialog, and sent on the wire. */
export const DELETE_ACCOUNT_CONFIRMATION = "DELETE ACCOUNT";

export interface DeleteAccountResult {
  ok: true;
  /** True when the row stayed as a placeholder because others still share it. */
  convertedToGhost: boolean;
}

export async function deleteAccount(userId: string): Promise<DeleteAccountResult> {
  const others = await transaction(async (trx) => listSharingRealAccounts(trx, userId));
  if (others.length > 0) {
    await convertToGhost(userId);
    return { ok: true, convertedToGhost: true };
  }

  try {
    await wipeUserLedger(userId);
  } catch (err) {
    // Someone joined between the check and the wipe. Keep their balances:
    // become a placeholder rather than retrying a delete that would take them.
    if (err instanceof WipeBlockedError) {
      await convertToGhost(userId);
      return { ok: true, convertedToGhost: true };
    }
    throw err;
  }

  await retireAccount(userId);
  return { ok: true, convertedToGhost: false };
}

/**
 * Strip login, keep the person. Other accounts still see this name on their
 * bills; they can mint a guest link now that `is_ghost = 1`.
 */
async function convertToGhost(userId: string): Promise<void> {
  await transaction(async (trx) => {
    const user = await trx
      .selectFrom("users")
      .select(["email", "is_ghost", "deleted_at"])
      .where("id", "=", userId)
      .executeTakeFirst();
    if (!user || user.deleted_at) return;
    if (user.is_ghost === 1) {
      await stripCredentials(trx, userId);
      return;
    }

    const now = new Date().toISOString();
    await trx
      .updateTable("users")
      .set({
        is_ghost: 1,
        email: null,
        password_hash: null,
        email_verified_at: null,
        invite_email: user.email,
        updated_at: now,
      })
      .where("id", "=", userId)
      .execute();

    await stripCredentials(trx, userId);
    await logChange(trx, {
      entity: "user",
      entityId: userId,
      op: "upsert",
      actorUserId: userId,
    });
  });
}

/**
 * After a wipe: no ledger left, so a living placeholder would be an empty
 * ghost nobody can usefully claim. Soft-delete and free the email.
 */
async function retireAccount(userId: string): Promise<void> {
  await transaction(async (trx) => {
    const now = new Date().toISOString();
    await trx
      .updateTable("users")
      .set({
        is_ghost: 1,
        email: null,
        password_hash: null,
        email_verified_at: null,
        invite_email: null,
        deleted_at: now,
        updated_at: now,
      })
      .where("id", "=", userId)
      .execute();

    await stripCredentials(trx, userId);
  });
}

async function stripCredentials(trx: DB, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await trx.deleteFrom("sessions").where("user_id", "=", userId).execute();
  await trx.deleteFrom("email_tokens").where("user_id", "=", userId).execute();
  await trx
    .updateTable("api_tokens")
    .set({ revoked_at: now })
    .where("user_id", "=", userId)
    .where("revoked_at", "is", null)
    .execute();
}
