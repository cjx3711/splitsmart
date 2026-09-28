/**
 * The one sentence that says a total is leaving something out.
 *
 * Shared by the dashboard and the friend page, so the same situation is not
 * met in two different wordings - the same reason ConvertBalancesHint exists
 * in ConversionNote.tsx.
 *
 * Two things it must always do:
 *
 * - NAME THE GROUPS. "Some balances are excluded" makes you go hunting for
 *   which; you chose these, so the note can say so.
 * - OFFER THE FULL SUM. The headline is the number you asked for, but a total
 *   that quietly disagrees with the rows under it reads as a bug in a ledger,
 *   and the way out of that is one click, not a settings page.
 *
 * The toggle is deliberately NOT remembered. Leaving it on would quietly make
 * the full sum your normal view again, and you would have no reason to suspect
 * the headline had drifted back.
 */
import { listNames } from "./excludedTotals.ts";

export function ExcludedTotalsNote({
  names,
  showing,
  onToggle,
}: {
  /** Groups being left out. Nothing renders when empty. */
  names: string[];
  /** True while the totals above are showing everything. */
  showing: boolean;
  onToggle: () => void;
}) {
  if (names.length === 0) return null;
  const list = listNames(names);
  const plural = names.length > 1;

  return (
    <p className="excluded-note">
      {showing ? (
        <>
          Counting {list}, {plural ? "groups" : "a group"} you keep out of your totals.{" "}
          <button type="button" className="link" onClick={onToggle}>
            Leave {plural ? "them" : "it"} out
          </button>
        </>
      ) : (
        <>
          {list} {plural ? "are" : "is"} not counted here.{" "}
          <button type="button" className="link" onClick={onToggle}>
            Include {plural ? "them" : "it"}
          </button>
        </>
      )}
    </p>
  );
}
