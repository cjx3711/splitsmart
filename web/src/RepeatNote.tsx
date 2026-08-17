/**
 * What a bill says about its own recurrence.
 *
 * Three states worth spelling out, because a recurring series is the one place in
 * this app where the server creates money without anybody pressing a button:
 *
 *   template     "Repeats monthly, next on 1 March", plus how many bills it has
 *                produced so far, so a series that is generating twice is visible.
 *   behind       the next bill was due in the past. The scheduler catches up ONE
 *                occurrence per tick on purpose (a stack of three months of rent
 *                dated today would be worse), so a gap is a real state the UI has
 *                to admit to rather than hide.
 *   occurrence   this bill came out of a series, and editing it edits THIS BILL,
 *                not the schedule. Said out loud, with a link to the template.
 *
 * Shared by the logged-in and guest expense pages. Guests see occurrences —
 * they are ordinary expenses — but cannot create or change a template, so the
 * link back to one is only rendered when the caller supplies a route for it.
 */
import { Link } from "react-router-dom";
import { isBehind, repeatLabel, type RepeatInterval } from "../../src/domain/recurring.ts";

export function RepeatNote({
  repeatInterval,
  nextRepeat,
  repeatOf,
  seriesCount = 0,
  templateHref,
}: {
  repeatInterval: RepeatInterval | null | undefined;
  nextRepeat: string | null | undefined;
  repeatOf: string | null | undefined;
  /** Bills this template has generated. Ignored unless this IS a template. */
  seriesCount?: number;
  /** Where "the series" lives, for an occurrence. Omit to render plain text. */
  templateHref?: (templateId: string) => string;
}) {
  if (repeatInterval) {
    const behind = nextRepeat ? isBehind(nextRepeat) : false;

    return (
      <div className={behind ? "notice" : "card"}>
        <span className="eyebrow">Repeats</span>
        <p style={{ margin: "0.3rem 0 0" }}>
          {repeatLabel(repeatInterval)}
          {nextRepeat && !behind && <> · next on {nextRepeat.slice(0, 10)}</>}
          {seriesCount > 0 && (
            <>
              {" "}
              · {seriesCount} {seriesCount === 1 ? "bill" : "bills"} so far
            </>
          )}
        </p>
        {behind && nextRepeat && (
          <p className="muted" style={{ margin: "0.3rem 0 0" }}>
            This series is behind: the bill for {nextRepeat.slice(0, 10)} has not been created yet.
            One is added per hour until it catches up, each dated the day it was due, rather than
            all at once dated today.
          </p>
        )}
      </div>
    );
  }

  if (repeatOf) {
    return (
      <p className="muted" style={{ margin: "0.4rem 0 0" }}>
        One of a repeating series. Editing this changes this bill only, not the ones still to come
        {templateHref ? (
          <>
            {" "}
            — <Link to={templateHref(repeatOf)}>open the series</Link>.
          </>
        ) : (
          "."
        )}
      </p>
    );
  }

  return null;
}
