import Link from "next/link";
import { isRunActive, MODE_LABELS, seconds, timeAgo, type Mode, type RunReport } from "./report";

/** A store's name, its score in large type, and what state its latest run is in. */
export function RunHeader({
  mode,
  report,
  now,
  action,
}: {
  mode: Mode;
  report: RunReport | null;
  now: number;
  action?: React.ReactNode;
}) {
  const label = MODE_LABELS[mode];
  const active = isRunActive(report);
  const total = report?.summary.total ?? 6;
  const elapsed = report?.startedAt ? Math.max(0, Math.floor((now - Date.parse(report.startedAt)) / 1000)) : 0;

  return (
    <div className="flex h-full flex-col gap-4 rounded-lg border border-border p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{label.name}</h2>
          <p className="text-sm text-muted">{label.blurb}</p>
        </div>
        {action}
      </div>

      <div className="flex items-baseline gap-3">
        <p className="font-mono text-5xl font-semibold tabular-nums tracking-tight sm:text-6xl">
          {report ? report.summary.passed : "–"}
          <span className="text-muted">/{total}</span>
        </p>
        <p className="text-sm text-muted">scenarios passed</p>
      </div>

      <p className="text-sm text-muted" aria-live="polite" suppressHydrationWarning>
        {!report && "Not run yet."}
        {report && active && `Running · ${elapsed} s`}
        {report && !active && report.status === "ERROR" && `The run stopped: ${report.error ?? "unknown error"}`}
        {report && report.status === "COMPLETED" && (
          <>
            {report.summary.failed} failed
            {report.summary.inconclusive > 0 ? ` · ${report.summary.inconclusive} inconclusive` : ""} · {seconds(report.durationMs)} run ·{" "}
            {timeAgo(report.createdAt, now)} ·{" "}
            <Link
              href={`/proof/${report.id}`}
              className="text-foreground underline underline-offset-4 hover:text-muted focus-visible:outline-2 focus-visible:outline-ring"
            >
              Share results
            </Link>
          </>
        )}
      </p>
    </div>
  );
}
