import Link from "next/link";
import { isRunActive, MODE_LABELS, progressLabel, runTone, seconds, timeAgo, type Mode, type RunReport } from "./report";

/** Status colors pass WCAG AA on the page background in both themes (globals.css). */
const SCORE_COLORS = { pass: "text-pass", fail: "text-fail", warn: "text-warn" } as const;

/**
 * What the run cost, from the harms its assertions recorded. A run where every scenario passed says
 * so; a run that could not judge everything and found no harm says nothing.
 */
function Consequences({ report }: { report: RunReport }) {
  const harms = report.consequences ?? [];
  if (harms.length > 0) {
    return (
      <p className="text-sm font-medium leading-6 text-fail">
        <span className="text-muted">This run: </span>
        {harms.join(" · ")}
      </p>
    );
  }
  if (report.status === "COMPLETED" && report.summary.passed === report.summary.total) {
    return (
      <p className="text-sm font-medium leading-6 text-pass">
        <span className="text-muted">This run: </span>
        all {report.summary.total} failures handled, nothing charged or shipped twice
      </p>
    );
  }
  return null;
}

/** A store's name, its score in large type, what the run cost, and what state the run is in. */
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
  const tone = runTone(report);

  return (
    <div className="flex h-full flex-col gap-4 rounded-lg border border-border p-4 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold">{label.name}</h2>
          <p className="text-sm text-muted">{label.blurb}</p>
        </div>
        {action}
      </div>

      {/* While the run is live, its progress stands where the score will be: a partial score reads as final. */}
      {report && active ? (
        <p className="font-mono text-xl font-semibold tabular-nums sm:text-2xl" aria-live="polite" suppressHydrationWarning>
          {progressLabel(report, now)}
        </p>
      ) : (
        <div className="flex items-baseline gap-3">
          <p className="font-mono text-5xl font-semibold tabular-nums tracking-tight sm:text-6xl">
            <span className={tone ? SCORE_COLORS[tone] : undefined}>{report ? report.summary.passed : "–"}</span>
            <span className="text-muted">/{total}</span>
          </p>
          <p className="text-sm text-muted">scenarios passed</p>
        </div>
      )}

      {report && !active && <Consequences report={report} />}

      <p className="text-sm text-muted" aria-live="polite" suppressHydrationWarning>
        {!report && "Not run yet."}
        {report && !active && report.status === "ERROR" && `The run stopped: ${report.error ?? "unknown error"}`}
        {/* A run the server ended after its process died: finished, with why. */}
        {report && report.status === "COMPLETED" && report.error && (
          <>
            <span className="text-warn">{report.error}</span>
            <br />
          </>
        )}
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
