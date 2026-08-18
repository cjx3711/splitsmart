/**
 * Every bill in a repeating series, oldest first.
 *
 * A series is the first bill (the template, tagged "repeats") plus ordinary
 * expenses that point at it. There is no bundle table. This view exists so that
 * relationship is visible, and so deleting the first bill versus a later one
 * is not a surprise.
 *
 * Shared by the logged-in page (mirror) and the guest page (network).
 */
import type { ReactNode } from "react";
import { Breadcrumbs, type Crumb } from "./Breadcrumbs.tsx";
import { ExpenseList, type PersonLookup } from "./ExpenseList.tsx";
import { isBehind, repeatLabel, type RepeatInterval } from "../../src/domain/recurring.ts";
import type { ExpenseSummary } from "./api.ts";

export type SeriesStoppedReason = "deleted" | "ended" | null;

export function SeriesView({
  title,
  interval,
  nextRepeat,
  stoppedReason,
  bills,
  currentUserId,
  nameOf,
  trail,
  personLinks = true,
  stop,
}: {
  title: string;
  interval: RepeatInterval | null;
  nextRepeat: string | null;
  stoppedReason: SeriesStoppedReason;
  bills: ExpenseSummary[];
  currentUserId: string;
  nameOf: PersonLookup;
  trail: Crumb[];
  personLinks?: boolean;
  stop?: ReactNode;
}) {
  const behind = nextRepeat ? isBehind(nextRepeat) : false;
  const upcomingDate = nextRepeat?.slice(0, 10);
  const upcomingAlready = Boolean(
    upcomingDate &&
      bills.some((b) => !b.deleted_at && b.date.slice(0, 10) === upcomingDate),
  );
  const showUpcoming = !stoppedReason && upcomingDate && !upcomingAlready;

  return (
    <>
      <Breadcrumbs trail={trail} />

      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted" style={{ margin: 0 }}>
            {interval ? `${repeatLabel(interval)} series` : "Repeating series"}
          </p>
        </div>
        {stop && <div className="page-actions">{stop}</div>}
      </div>

      {stoppedReason === "deleted" ? (
        <div className="notice">
          This series has stopped. The first bill was deleted, so no more will be created. The
          bills already made stay.
        </div>
      ) : stoppedReason === "ended" ? (
        <div className="notice">
          This series has stopped. No more bills will be created. The ones already made stay.
        </div>
      ) : (
        <p className="muted">
          Each bill is its own expense. Deleting a later one does not stop the series. Deleting the
          first bill (the one marked repeats) stops new bills; the ones already made stay.
        </p>
      )}

      <h2>Bills</h2>
      <ExpenseList
        expenses={bills}
        currentUserId={currentUserId}
        nameOf={nameOf}
        personLinks={personLinks}
        empty="No bills in this series."
        after={
          showUpcoming ? (
            <div className="list-item">
              <div className="list-item-body">
                <div className="list-item-title">Coming</div>
                <div className="muted">
                  {upcomingDate} · {behind ? "will be created soon" : "next"}
                </div>
              </div>
            </div>
          ) : null
        }
      />
    </>
  );
}
