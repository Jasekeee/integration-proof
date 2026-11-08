"use client";

import { Odometer, useChanges } from "./motion";
import { cellState, isRunActive, MODE_LABELS, runProgress, runTone, type CellState, type Mode, type RunReport } from "./report";

const SCORE_COLORS = { pass: "text-pass", fail: "text-fail", warn: "text-warn" } as const;

/** A live run's progress, one segment per scenario: tinted while live, in full color once decided. */
const SEGMENTS: Record<CellState, string> = {
  PASS: "bg-pass",
  FAIL: "bg-fail",
  INCONCLUSIVE: "bg-warn",
  WAITING: "bg-warn-bg shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--warn)_45%,transparent)]",
  RUNNING: "bg-[color-mix(in_srgb,var(--brand)_32%,var(--surface-2))]",
  QUEUED: "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]",
  ERROR: "bg-border-strong",
  "NOT RUN": "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]",
};

/**
 * One store's score in large type. While its run is live, the progress stands in its place: a
 * partial score would read as the final one. The score rolls up when this page saw the run end.
 */
export function Tally({ mode, report, now, previous }: { mode: Mode; report: RunReport | null; now: number; previous: boolean }) {
  const active = isRunActive(report);
  const ended = useChanges(active) > 0 && !active;
  const tone = runTone(report);
  const total = report?.summary.total ?? 6;
  const progress = report && active ? runProgress(report, now) : null;
  return (
    <div className={`flex min-w-0 flex-col items-center transition-opacity duration-200 ${previous ? "opacity-60" : ""}`}>
      {progress ? (
        <p className="flex h-[clamp(4rem,9vw,7.5rem)] flex-col items-center justify-center gap-2" aria-live="polite">
          <span className="grid w-40 grid-cols-6 gap-1 sm:w-56" aria-hidden="true">
            {report!.scenarios.map((scenario) => (
              <span
                key={scenario.id}
                className={`segment h-1.5 rounded-full ${SEGMENTS[cellState(scenario)]}`}
              />
            ))}
          </span>
          <span className="whitespace-nowrap text-base font-medium tabular-nums sm:text-lg" suppressHydrationWarning>
            Running · {progress.done} of {progress.total} done · {progress.elapsedS} s
          </span>
        </p>
      ) : (
        <p className="flex h-[clamp(4rem,9vw,7.5rem)] items-center text-[clamp(4rem,9vw,7.5rem)] font-semibold leading-none tracking-[-0.055em] tabular-nums">
          <span className={`inline-flex h-[1em] ${tone ? SCORE_COLORS[tone] : "text-muted"}`}>
            {report ? <Odometer key={report.id} value={report.summary.passed} max={total} roll={ended} /> : "–"}
            <span>/{total}</span>
          </span>
        </p>
      )}
      <p className="mt-3 text-lg font-medium">{MODE_LABELS[mode].name}</p>
      <p className="text-small text-muted">{previous ? "previous run" : MODE_LABELS[mode].description}</p>
    </div>
  );
}

