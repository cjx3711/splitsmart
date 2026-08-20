/**
 * How recently you shared an expense with someone.
 *
 * Derived at read time from live expenses, never stored. A column on
 * `friendships` would miss derived friends (there is no row for those), and
 * every insert / import / delete / restore would need a matching write that
 * could drift from the ledger. The expense ULID already encodes created time,
 * including for Splitwise import (`originalInstant` stamps both the id and
 * `created_at`), so MAX(expense id) among bills you are both on is "the latest
 * expense with me".
 */
export function lastSharedExpenseIdByUser(
  expenses: ReadonlyArray<{ id: string; shares: ReadonlyArray<{ userId: string }> }>,
  selfId: string,
): Map<string, string> {
  const last = new Map<string, string>();
  for (const expense of expenses) {
    if (!expense.shares.some((s) => s.userId === selfId)) continue;
    for (const share of expense.shares) {
      if (share.userId === selfId) continue;
      const prev = last.get(share.userId);
      if (prev === undefined || expense.id > prev) last.set(share.userId, expense.id);
    }
  }
  return last;
}

/**
 * Newest shared expense first. Friends you have never been on a bill with
 * sort last, then by display name so the order is stable.
 */
export function compareByLastExpense(
  aId: string,
  bId: string,
  lastByUser: Map<string, string>,
  nameA: string,
  nameB: string,
): number {
  const ta = lastByUser.get(aId) ?? "";
  const tb = lastByUser.get(bId) ?? "";
  if (ta !== tb) return ta < tb ? 1 : -1;
  return nameA.localeCompare(nameB);
}
