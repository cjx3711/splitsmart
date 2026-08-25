/**
 * Group settings that are a live call, not an outbox op.
 *
 * `simplify_by_default` is edited from two screens now - Options, and the
 * shortcut under the payment list on the group page - so the write lives here
 * once. Mirror first so the liveQuery screens flip immediately, then the
 * server, then roll the mirror back if the server refuses (the same shape as
 * the other writes in sync/localFirst.ts, which stays free of `api` imports).
 *
 * `default_currency` follows the same shape. It decides what currency the next
 * bill in this group STARTS in (web/src/AddExpenseDialog.tsx prefers it over
 * your own preferred currency) and what the group screen offers to convert to.
 * It moves no money: recorded expenses keep the currency they were entered in
 * and no balance is converted (CLAUDE.md, rule 2).
 */
import { api } from "./api.ts";
import { patchGroup } from "./sync/localFirst.ts";
import type { LocalDb } from "./db/local.ts";

export async function setGroupSimplify(
  db: LocalDb,
  groupId: string,
  on: boolean,
): Promise<void> {
  const previous = await patchGroup(db, groupId, { simplifyByDefault: on });
  try {
    await api.updateGroup(groupId, { simplifyByDefault: on });
  } catch (err) {
    if (previous) {
      await patchGroup(db, groupId, {
        simplifyByDefault: previous.simplifyByDefault !== false,
      });
    }
    throw err;
  }
}

export async function setGroupCurrency(
  db: LocalDb,
  groupId: string,
  code: string,
): Promise<void> {
  const previous = await patchGroup(db, groupId, { defaultCurrency: code });
  try {
    await api.updateGroup(groupId, { defaultCurrency: code });
  } catch (err) {
    if (previous) {
      await patchGroup(db, groupId, { defaultCurrency: previous.defaultCurrency });
    }
    throw err;
  }
}
