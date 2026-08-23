/**
 * Settle-up suggestions.
 *
 * PURE, and its own module for exactly one reason: the browser imports it. The
 * offline mirror derives every balance locally (docs/OFFLINE.md, decision 3), and
 * src/domain/balances.ts cannot be imported into a bundle - it pulls in kysely.
 * Same arrangement as src/domain/split.ts, src/domain/ulid.ts and
 * src/domain/recurring.ts: keep it free of I/O and both sides can run the one
 * implementation instead of drifting apart by a cent.
 *
 * src/domain/balances.ts re-exports this, so server callers need not know it
 * moved.
 */
/**
 * Collapses a set of net positions into the fewest transfers that settle them
 * ("simplify debts").
 *
 * Greedy largest-creditor / largest-debtor matching. This is not guaranteed
 * minimal in the general case; that problem is NP-hard, but it produces at
 * most n-1 transfers and matches what people expect. The ledger is untouched:
 * `expense_repayments` stays the per-bill derivation, and friend totals apply
 * this on read when a group has simplify on.
 */
export function simplifyDebts(
  balances: Array<{ userId: string; amountMinor: number }>,
): Array<{ fromUserId: string; toUserId: string; amountMinor: number }> {
  const total = balances.reduce((sum, b) => sum + b.amountMinor, 0);
  if (total !== 0) {
    throw new Error(
      `Cannot simplify: balances sum to ${total}, expected 0. The ledger is inconsistent.`,
    );
  }

  const creditors = balances
    .filter((b) => b.amountMinor > 0)
    .map((b) => ({ ...b }))
    .sort((a, b) => b.amountMinor - a.amountMinor || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

  const debtors = balances
    .filter((b) => b.amountMinor < 0)
    .map((b) => ({ userId: b.userId, amountMinor: -b.amountMinor }))
    .sort((a, b) => b.amountMinor - a.amountMinor || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));

  const transfers: Array<{ fromUserId: string; toUserId: string; amountMinor: number }> = [];
  let ci = 0;
  let di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci]!;
    const debtor = debtors[di]!;
    const amount = Math.min(creditor.amountMinor, debtor.amountMinor);

    if (amount > 0) {
      transfers.push({
        fromUserId: debtor.userId,
        toUserId: creditor.userId,
        amountMinor: amount,
      });
    }

    creditor.amountMinor -= amount;
    debtor.amountMinor -= amount;
    if (creditor.amountMinor === 0) ci++;
    if (debtor.amountMinor === 0) di++;
  }

  return transfers;
}

/**
 * One directed edge of a viewer's pairwise balance, in one group and currency.
 *
 * Positive `amountMinor` means `otherUserId` owes the viewer. The same sign
 * convention as `getPairwiseBalances`.
 */
export interface PairwiseEdge {
  otherUserId: string;
  groupId: string | null;
  currencyCode: string;
  amountMinor: number;
}

export interface GroupNet {
  groupId: string | null;
  userId: string;
  currencyCode: string;
  amountMinor: number;
}

/**
 * Rebuilds a viewer's pairwise edges after per-group simplify-debts.
 *
 * Splitwise's friend totals are this, not the raw who-owes-whom on each bill:
 * a cycle A→B→C→A inside a group with simplify on collapses to nothing, and a
 * third party's debt can be rerouted onto you. Nets are unchanged; only the
 * edges are. Groups whose nets do not sum to zero (a truncated import residue
 * that somehow escaped the writer) keep their raw edges rather than throwing.
 *
 * `groupId === null` is the one-on-one bucket. It is never simplified: people
 * who only share separate 1-1 bills are not a group, and should not be asked
 * to settle with each other.
 */
export function pairwiseWithSimplify(input: {
  viewerId: string;
  raw: PairwiseEdge[];
  nets: GroupNet[];
  /** `true` for a group whose `simplify_by_default` is on. Missing = off. */
  simplifyByGroupId: ReadonlyMap<string, boolean>;
}): PairwiseEdge[] {
  const shouldSimplify = (groupId: string | null): boolean =>
    groupId !== null && (input.simplifyByGroupId.get(groupId) ?? false);

  const rawByKey = new Map<string, PairwiseEdge[]>();
  for (const edge of input.raw) {
    const key = bucketKey(edge.groupId, edge.currencyCode);
    const list = rawByKey.get(key) ?? [];
    list.push(edge);
    rawByKey.set(key, list);
  }

  const netsByKey = new Map<string, Array<{ userId: string; amountMinor: number }>>();
  for (const net of input.nets) {
    if (net.amountMinor === 0) continue;
    const key = bucketKey(net.groupId, net.currencyCode);
    const list = netsByKey.get(key) ?? [];
    list.push({ userId: net.userId, amountMinor: net.amountMinor });
    netsByKey.set(key, list);
  }

  const keys = new Set([...rawByKey.keys(), ...netsByKey.keys()]);
  const result: PairwiseEdge[] = [];

  for (const key of keys) {
    const { groupId, currencyCode } = parseBucketKey(key);
    if (!shouldSimplify(groupId)) {
      result.push(...(rawByKey.get(key) ?? []));
      continue;
    }

    const nets = netsByKey.get(key) ?? [];
    const total = nets.reduce((sum, n) => sum + n.amountMinor, 0);
    // A cycle nets to zero, so the zero-nets were dropped above and `nets` is
    // empty. That is a successful simplify (no edges), not a reason to keep the
    // raw cycle. Only a nonzero residue — truncated import dust that escaped
    // the writer — falls back to the unsimplified edges.
    if (total !== 0) {
      result.push(...(rawByKey.get(key) ?? []));
      continue;
    }
    if (nets.length === 0) continue;

    const transfers = simplifyDebts(nets);
    for (const transfer of transfers) {
      if (transfer.fromUserId === input.viewerId) {
        result.push({
          otherUserId: transfer.toUserId,
          groupId,
          currencyCode,
          amountMinor: -transfer.amountMinor,
        });
      } else if (transfer.toUserId === input.viewerId) {
        result.push({
          otherUserId: transfer.fromUserId,
          groupId,
          currencyCode,
          amountMinor: transfer.amountMinor,
        });
      }
    }
  }

  return result.filter((edge) => edge.amountMinor !== 0);
}

function bucketKey(groupId: string | null, currencyCode: string): string {
  return `${groupId ?? ""}\0${currencyCode}`;
}

function parseBucketKey(key: string): { groupId: string | null; currencyCode: string } {
  const split = key.indexOf("\0");
  const group = key.slice(0, split);
  return {
    groupId: group === "" ? null : group,
    currencyCode: key.slice(split + 1),
  };
}
