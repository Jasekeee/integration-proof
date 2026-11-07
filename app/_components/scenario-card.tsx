"use client";

import { useId } from "react";
import { AnalysisPanel } from "./analysis-panel";
import { HandlingCode } from "./handling-code";
import { FALLBACK_HEADLINES, MODE_LABELS, SCENARIO_TITLES, seconds, verdictTone, waitLabel, type Mode, type ScenarioView, type StoreCode } from "./report";
import { VerdictBadge } from "./verdict-badge";

/**
 * The thin stripe on a card's left edge, an inset shadow so it follows the rounded corners without
 * clipping the card's content. The badge carries the meaning; the stripe repeats it.
 */
const STRIPES = {
  pass: "shadow-[inset_3px_0_0_0_var(--pass)]",
  fail: "shadow-[inset_3px_0_0_0_var(--fail)]",
  warn: "shadow-[inset_3px_0_0_0_var(--warn)]",
  error: "shadow-[inset_3px_0_0_0_var(--border-strong)]",
} as const;

function liveHeadline(scenario: ScenarioView, now: number, deadlineMs: number): string {
  const since = (iso: string | null) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / 1000)) : 0);
  if (scenario.status === "QUEUED") return "Queued";
  if (scenario.status === "WAITING_FOR_WEBHOOK") {
    return waitLabel(scenario.waitingSince ? now - Date.parse(scenario.waitingSince) : 0, deadlineMs);
  }
  if (scenario.status === "RUNNING") return `Running · ${since(scenario.startedAt)} s`;
  if (scenario.status === "ERROR") return "Could not run";
  if (scenario.headline) return scenario.headline;
  if (scenario.verdict === "INCONCLUSIVE") return "PayPal did not deliver in time";
  return (scenario.verdict && FALLBACK_HEADLINES[scenario.id]?.[scenario.verdict]) ?? scenario.statusLabel;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`size-4 shrink-0 text-muted motion-safe:transition-transform motion-safe:duration-200 ${open ? "rotate-180" : ""}`}
    >
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * One store's result for one scenario. Folded, a PASS is one line and a FAIL its headline, one line
 * of reason and whether Claude's fix was verified; unfolded, the analysis, the store's code and the
 * trace button. The trace itself is drawn by the parent, as wide as the page.
 */
export function ScenarioCard({
  id,
  mode,
  scenario,
  now,
  deadlineMs,
  code,
  expanded,
  onToggle,
  traceOpen,
  traceId,
  onToggleTrace,
  onStep,
  dimmed = false,
}: {
  id: string;
  mode: Mode;
  scenario: ScenarioView | null;
  now: number;
  deadlineMs: number;
  code: StoreCode;
  expanded: boolean;
  onToggle: () => void;
  traceOpen: boolean;
  /** The id of the trace section this card opens, for aria-controls. */
  traceId: string;
  onToggleTrace: () => void;
  onStep: (seq: number) => void;
  /** A previous run's result while a new run of this store is under way. */
  dimmed?: boolean;
}) {
  const bodyId = useId();
  const steps = scenario?.steps ?? [];
  const failed = scenario?.verdict === "FAIL" || scenario?.verdict === "INCONCLUSIVE";
  const passed = scenario?.verdict === "PASS";
  const tone = verdictTone(scenario?.verdict ?? null);
  const stripe = tone ? STRIPES[tone] : scenario?.status === "ERROR" ? STRIPES.error : "";
  const headline = scenario ? liveHeadline(scenario, now, deadlineMs) : "Not run yet";
  const reason = scenario?.reason ?? scenario?.error ?? null;
  const fixVerified = scenario?.analysis?.fixCheck?.verified === true;
  const foldable = scenario?.status === "COMPLETED" || scenario?.status === "ERROR";
  const open = expanded || !foldable;

  const toggle = foldable && (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={bodyId}
      aria-label={`${expanded ? "Fold" : "Unfold"} ${id}, ${MODE_LABELS[mode].name}`}
      onClick={onToggle}
      className="-my-2 -mr-2 grid size-10 shrink-0 place-items-center rounded-md hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
    >
      <Chevron open={expanded} />
    </button>
  );

  // A folded PASS: one line, the headline and the badge.
  if (passed && !open) {
    return (
      <article
        aria-label={`${id} · ${MODE_LABELS[mode].name}`}
        className={`flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-2 pl-5 ${stripe} ${dimmed ? "opacity-60" : ""} motion-safe:transition-opacity motion-safe:duration-200`}
      >
        <p className="flex min-w-0 flex-1 items-baseline gap-2 text-sm">
          <span className="shrink-0 font-mono text-xs text-muted">{id}</span>
          <span className="truncate">{headline}</span>
        </p>
        <VerdictBadge scenario={scenario} />
        {toggle}
      </article>
    );
  }

  return (
    <article
      aria-label={`${id} · ${MODE_LABELS[mode].name}`}
      className={`flex h-full min-w-0 flex-col gap-3 rounded-lg border border-border bg-surface p-4 pl-5 ${stripe} ${dimmed ? "opacity-60" : ""} motion-safe:transition-opacity motion-safe:duration-200`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-mono text-xs text-muted">
            {id} · {SCENARIO_TITLES[id] ?? scenario?.title} · {MODE_LABELS[mode].name}
          </p>
          <h3 className="text-base font-semibold leading-6" suppressHydrationWarning>
            {headline}
          </h3>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <VerdictBadge scenario={scenario} />
          {toggle}
        </div>
      </header>

      {!open && !passed && (reason || fixVerified) && (
        <div className="flex flex-col gap-2">
          {reason && <p className="line-clamp-1 text-sm leading-6 text-muted">{reason}</p>}
          {fixVerified && (
            <p>
              <span className="inline-flex rounded-md bg-pass-bg px-2 py-1 font-mono text-xs font-semibold text-pass">
                Fix verified
              </span>
            </p>
          )}
        </div>
      )}

      {open && (
        <div id={bodyId} className="flex min-w-0 flex-col gap-3">
          {reason && <p className="text-sm leading-6 text-muted">{reason}</p>}

          {scenario && failed && <AnalysisPanel scenario={scenario} onStep={onStep} />}

          {passed && <HandlingCode id={id} mode={mode} code={code} />}

          {steps.length > 0 && (
            <button
              type="button"
              aria-expanded={traceOpen}
              aria-controls={traceId}
              onClick={onToggleTrace}
              className="-mx-2 min-h-10 self-start rounded-md px-2 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
            >
              {traceOpen ? "Hide trace" : `Show trace · ${steps.length} steps`}
            </button>
          )}

          {scenario?.durationMs !== null && scenario?.durationMs !== undefined && scenario.status === "COMPLETED" && (
            <p className="mt-auto font-mono text-xs text-muted">Finished in {seconds(scenario.durationMs)}</p>
          )}
        </div>
      )}
    </article>
  );
}

