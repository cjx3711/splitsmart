/**
 * SVG bar chart for the admin usage series. No chart library — keeps the
 * dependency surface small and smoke snapshots deterministic.
 */
import type { UsageDay } from "./api.ts";

export function UsageChart({
  series,
  height = 96,
  compact = false,
}: {
  series: UsageDay[];
  height?: number;
  /** Smaller sparkline for list rows. */
  compact?: boolean;
}) {
  const max = Math.max(1, ...series.map((d) => d.count));
  const gap = compact ? 1 : 2;
  const barW = compact ? 3 : 6;
  const width = series.length * (barW + gap) - gap;
  const padTop = 2;
  const usable = height - padTop;

  return (
    <svg
      className={compact ? "usage-chart usage-chart--compact" : "usage-chart"}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Expenses added over ${series.length} days`}
    >
      {series.map((d, i) => {
        const h = d.count === 0 ? 0 : Math.max(1, Math.round((d.count / max) * usable));
        const x = i * (barW + gap);
        const y = height - h;
        return (
          <rect
            key={d.date}
            x={x}
            y={y}
            width={barW}
            height={h}
            rx={1}
            className="usage-chart-bar"
            aria-label={`${d.date}: ${d.count}`}
          >
            <title>{`${d.date}: ${d.count}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}
