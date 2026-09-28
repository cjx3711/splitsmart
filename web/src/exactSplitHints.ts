import { parseAmount, splitEvenly } from "../../src/domain/money.ts";

/** Suggestions only: blank fields still count as zero until the user types. */
export function exactSplitHints(
  totalMinor: number,
  participantIds: string[],
  values: Record<string, string>,
  decimals: number,
): { remainingMinor: number; emptyCount: number; suggestions: Map<string, number> } | null {
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0 || !participantIds.length) return null;
  const empty: string[] = [];
  let allocated = 0;
  try {
    for (const id of participantIds) {
      const raw = (values[id] ?? "").trim();
      if (!raw) { empty.push(id); continue; }
      const amount = parseAmount(raw, decimals);
      if (amount < 0) return null;
      allocated += amount;
      if (!Number.isSafeInteger(allocated)) return null;
    }
  } catch { return null; }
  const remainingMinor = totalMinor - allocated;
  // Stable ID order matches the split engine's allocation of spare minor units.
  empty.sort();
  const shares = remainingMinor >= 0 && empty.length ? splitEvenly(remainingMinor, empty.length) : [];
  return {
    remainingMinor,
    emptyCount: empty.length,
    suggestions: new Map(shares.map((share, index) => [empty[index]!, share])),
  };
}
