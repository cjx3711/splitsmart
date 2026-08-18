/**
 * What a bill says about its own recurrence.
 *
 * Three states worth spelling out, because a recurring series is the one place in
 * this app where the server creates money without anybody pressing a button:
 *
 *   template     "Repeats monthly, next on 1 March", plus how many bills it has
 *                produced so far, so a series that is generating twice is visible.
 *   paused       repeating was stopped. Resume starts from today and does not
 *                create the months that were missed.
 *   behind       the next bill was due in the past. Said as "will be created
 *                soon" rather than explaining the scheduler.
 *   occurrence   this bill came out of a series, and editing it edits THIS BILL,
 *                not the schedule. Said out loud, with a link to every bill.
 *
 * Shared by the logged-in and guest expense pages. Stop repeating lives in this
 * mark, not in a separate control: later bills point at the first one, and the
 * button always ends that first bill's schedule.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { isBehind, repeatLabel, type RepeatInterval } from "../../src/domain/recurring.ts";

export function RepeatNote({
  repeatInterval,
  nextRepeat,
  repeatOf,
  repeatPaused,
  seriesCount = 0,
  seriesHref,
  stop,
}: {
  repeatInterval: RepeatInterval | null | undefined;
  nextRepeat: string | null | undefined;
  repeatOf: string | null | undefined;
  /** Set while repeating is stopped; the interval it will resume with. */
  repeatPaused?: RepeatInterval | null | undefined;
  /** Bills this template has generated. Ignored unless this IS a template. */
  seriesCount?: number;
  /** Where every bill in the series is listed. Omit to render without a link. */
  seriesHref?: string;
  /** Stop or resume repeating. Logged-in only. */
  stop?: ReactNode;
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
            The bill for {nextRepeat.slice(0, 10)} will be created soon.
          </p>
        )}
        {seriesHref && (
          <p style={{ margin: "0.3rem 0 0" }}>
            <Link to={seriesHref}>View all bills in this series</Link>
          </p>
        )}
        {stop && <p style={{ margin: "0.3rem 0 0" }}>{stop}</p>}
      </div>
    );
  }

  if (repeatPaused) {
    return (
      <div className="notice">
        <span className="eyebrow">Series</span>
        <p style={{ margin: "0.3rem 0 0" }}>
          {repeatLabel(repeatPaused)} repeating is stopped. Resume starts from today - missed bills
          will not be created.
        </p>
        {seriesCount > 0 && (
          <p className="muted" style={{ margin: "0.3rem 0 0" }}>
            {seriesCount} {seriesCount === 1 ? "bill" : "bills"} so far
          </p>
        )}
        {seriesHref && (
          <p style={{ margin: "0.3rem 0 0" }}>
            <Link to={seriesHref}>View all bills in this series</Link>
          </p>
        )}
        {stop && <p style={{ margin: "0.3rem 0 0" }}>{stop}</p>}
      </div>
    );
  }

  if (repeatOf) {
    return (
      <div className="card">
        <span className="eyebrow">Series</span>
        <p style={{ margin: "0.3rem 0 0" }}>
          One of a repeating series. Editing this changes this bill only, not the ones still to come
          {seriesHref ? (
            <>
              {" "}
              - <Link to={seriesHref}>view all bills</Link>.
            </>
          ) : (
            "."
          )}
        </p>
        {stop && <p style={{ margin: "0.3rem 0 0" }}>{stop}</p>}
      </div>
    );
  }

  return null;
}

/**
 * Extra copy on the delete confirmation, when this bill is part of a series.
 *
 * The first bill IS the schedule, so deleting it is the destructive way to stop
 * repeating - that case is a warning, not a footnote. An occurrence is just a
 * bill, so the rest of the series continues.
 */
export function seriesDeleteNote(expense: {
  repeat_interval?: string | null;
  repeat_of?: string | null;
  repeat_paused?: string | null;
}): { kind: "template" | "occurrence"; text: string } | null {
  if (expense.repeat_interval || expense.repeat_paused) {
    return {
      kind: "template",
      text: "This is the first bill of the series. Deleting it stops new bills from being created. The bills already made stay.",
    };
  }
  if (expense.repeat_of) {
    return {
      kind: "occurrence",
      text: "This is one bill in a repeating series. Deleting it does not stop the rest.",
    };
  }
  return null;
}
