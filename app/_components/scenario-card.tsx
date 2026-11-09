"use client";

import { FALLBACK_HEADLINES, MODE_LABELS, plainHeadline, seconds, waitLabel, type Mode, type ScenarioView } from "./report";
import { buttonText, panel, panelLabel } from "./ui";
import { VerdictBadge } from "./verdict-badge";

function liveHeadline(scenario: ScenarioView, now: number, deadlineMs: number): string {
  const since = (iso: string | null) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / 1000)) : 0);
  if (scenario.status === "QUEUED") return "Queued";
  if (scenario.status === "WAITING_FOR_WEBHOOK") {
    return waitLabel(scenario.waitingSince ? now - Date.parse(scenario.waitingSince) : 0, deadlineMs);
  }
  if (scenario.status === "RUNNING") return `Running · ${since(scenario.startedAt)} s`;
  if (scenario.status === "ERROR") return "Could not run";
  if (scenario.headline) return plainHeadline(scenario.headline);
  if (scenario.verdict === "INCONCLUSIVE") return "PayPal did not deliver in time";
  return (scenario.verdict && FALLBACK_HEADLINES[scenario.id]?.[scenario.verdict]) ?? scenario.statusLabel;
}

/**
 * One store's result for one scenario in the technical layer: the verdict, its headline, the reason
 * the assertion gave, and the button that opens the trace. Claude's analysis, the store's code and
 * the trace itself are drawn by the parent, as wide as the scenario.
 */
export function ScenarioCard({
  id,
  mode,
  scenario,
  now,
  deadlineMs,
  traceOpen,
  traceId,
  onToggleTrace,
  dimmed = false,
}: {
  id: string;
  mode: Mode;
  scenario: ScenarioView | null;
  now: number;
  deadlineMs: number;
  traceOpen: boolean;
  /** The id of the trace section this card opens, for aria-controls. */
  traceId: string;
  onToggleTrace: () => void;
  /** A previous run's result while a new run of this store is under way. */
  dimmed?: boolean;
}) {
  const steps = scenario?.steps ?? [];
  const headline = scenario ? liveHeadline(scenario, now, deadlineMs) : "Not run yet";
  const reason = scenario?.reason ?? scenario?.error ?? null;
  const finished = scenario?.status === "COMPLETED" && scenario.durationMs !== null ? seconds(scenario.durationMs) : null;

  return (
    <article
      aria-label={`${id} · ${MODE_LABELS[mode].name}`}
      className={`flex h-full min-w-0 flex-col gap-3 transition-opacity duration-200 ${panel} ${dimmed ? "opacity-60" : ""}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className={panelLabel}>{MODE_LABELS[mode].name}</p>
          <h3 className="text-lg font-semibold leading-7 tracking-tight tabular-nums" suppressHydrationWarning>
            {headline}
          </h3>
        </div>
        <VerdictBadge scenario={scenario} />
      </header>

      {reason && <p className="measure text-sm leading-6 text-pretty text-muted">{reason}</p>}

      {(steps.length > 0 || finished) && (
        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-4 gap-y-1 pt-1">
          {steps.length > 0 && (
            <button type="button" aria-expanded={traceOpen} aria-controls={traceId} onClick={onToggleTrace} className={buttonText}>
              {traceOpen ? "Hide trace" : `Show trace · ${steps.length} steps`}
            </button>
          )}
          {finished && <p className="text-xs tabular-nums text-muted">Finished in {finished}</p>}
        </div>
      )}
    </article>
  );
}
