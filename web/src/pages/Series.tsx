/**
 * Every bill in a repeating series, oldest first.
 *
 * Reached from a template or from one of its copies; the template's id is the
 * series. Reads the mirror, so a bill queued on this device is here before it
 * has reached the server.
 */
import { useParams } from "react-router-dom";
import { SeriesView } from "../SeriesView.tsx";
import { makeLookup } from "../ExpenseList.tsx";
import {
  ResumeRepeatingButton,
  ResumeSeriesDialog,
  StopRepeatingButton,
  StopSeriesDialog,
  useStopSeries,
} from "../stopSeries.tsx";
import { useAuth } from "../App.tsx";
import { useSeries } from "../localData.ts";
import { Skeleton } from "../Skeleton.tsx";

export function Series() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const series = useSeries(id);
  const stop = useStopSeries(series?.templateId);

  if (series === undefined || !user) return <Skeleton kind="series" />;
  if (series === null) return <p className="empty">This expense is not part of a repeating series.</p>;

  const trail = series.groupId
    ? [
        { label: "Groups", to: "/groups" },
        { label: series.groupName ?? "Group", to: `/groups/${series.groupId}` },
        { label: series.title, to: `/expenses/${series.templateId}` },
        { label: "Series" },
      ]
    : [
        { label: "All expenses", to: "/expenses" },
        { label: series.title, to: `/expenses/${series.templateId}` },
        { label: "Series" },
      ];

  const nameOf = makeLookup(series.people, user.id);

  return (
    <>
      <SeriesView
        title={series.title}
        interval={series.interval}
        nextRepeat={series.nextRepeat}
        stoppedReason={series.stoppedReason}
        bills={series.bills}
        currentUserId={user.id}
        nameOf={nameOf}
        trail={trail}
        stop={
          stop.live ? (
            <StopRepeatingButton onClick={stop.requestStop} />
          ) : stop.paused ? (
            <ResumeRepeatingButton onClick={stop.requestResume} />
          ) : undefined
        }
      />
      <StopSeriesDialog
        open={stop.confirming === "stop"}
        busy={stop.busy}
        error={stop.error}
        onClose={() => stop.setConfirming(null)}
        onConfirm={stop.confirmStop}
      />
      <ResumeSeriesDialog
        open={stop.confirming === "resume"}
        busy={stop.busy}
        error={stop.error}
        resumeOn={stop.resumeOn}
        onClose={() => stop.setConfirming(null)}
        onConfirm={stop.confirmResume}
      />
    </>
  );
}
