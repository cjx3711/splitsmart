/**
 * Keeps the per-user localStorage recency map in step with the mirror.
 *
 * Called from expense writes (sync apply and the outbox). A missing cache, or
 * a delete of someone's or a group's latest bill, rebuilds from the live
 * ledger once.
 */
import { getMeta, setMeta, type LocalDb, type LocalExpense } from "./local.ts";
import { relatedUserIds } from "./queries.ts";
import {
  applyTouchedExpenses,
  cacheFromExpenses,
  loadFriendRecency,
  saveFriendRecency,
} from "./friendRecencyCache.ts";

export async function rememberFriendRecency(
  db: LocalDb,
  selfId: string,
  touched: LocalExpense[],
): Promise<void> {
  const current = loadFriendRecency(selfId);
  let next = current ? applyTouchedExpenses(current, touched, selfId) : null;
  if (!next) {
    const expenses = await db.expenses.toArray();
    next = cacheFromExpenses(expenses, selfId, await relatedUserIds(db, selfId, expenses));
  }
  if (current && sameCache(current, next)) return;
  saveFriendRecency(selfId, next);
  await setMeta(db, "friendRecencyRev", ((await getMeta(db, "friendRecencyRev")) ?? 0) + 1);
}

function sameCache(
  a: { last: Record<string, string>; lastByGroup: Record<string, string>; related: string[] },
  b: { last: Record<string, string>; lastByGroup: Record<string, string>; related: string[] },
): boolean {
  return JSON.stringify(a.last) === JSON.stringify(b.last) &&
    JSON.stringify(a.lastByGroup) === JSON.stringify(b.lastByGroup) &&
    a.related.join("\0") === b.related.join("\0");
}
