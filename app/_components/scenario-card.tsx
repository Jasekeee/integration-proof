"use client";

import dynamic from "next/dynamic";
import { useId, useState } from "react";
import { AnalysisPanel } from "./analysis-panel";
import { FALLBACK_HEADLINES, SCENARIO_TITLES, seconds, type ScenarioView } from "./report";
import { VerdictBadge } from "./verdict-badge";

// AG Grid needs the browser; it loads when a trace is first opened.
const TraceGrid = dynamic(() => import("./trace-grid"), {
  ssr: false,
  loading: () => <div className="h-24 rounded-md bg-surface-2 motion-safe:animate-pulse" />,
});

function liveHeadline(scenario: ScenarioView, now: number, deadlineMs: number): string {
  const since = (iso: string | null) => (iso ? Math.max(0, Math.floor((now - Date.parse(iso)) / 1000)) : 0);
  if (scenario.status === "QUEUED") return "Queued";
  if (scenario.status === "WAITING_FOR_WEBHOOK") {
    return `Waiting for PayPal webhook · ${since(scenario.waitingSince)} s of ${deadlineMs / 1000} s`;
  }
  if (scenario.status === "RUNNING") return `Running · ${since(scenario.startedAt)} s`;
  if (scenario.status === "ERROR") return "Could not run";
  if (scenario.headline) return scenario.headline;
  if (scenario.verdict === "INCONCLUSIVE") return "PayPal did not deliver in time";
  return (scenario.verdict && FALLBACK_HEADLINES[scenario.id]?.[scenario.verdict]) ?? scenario.statusLabel;
}

export function ScenarioCard({
  id,
  scenario,
  now,
  deadlineMs,
}: {
  id: string;
  scenario: ScenarioView | null;
  now: number;
  deadlineMs: number;
}) {
  const [traceOpen, setTraceOpen] = useState(false);
  const [highlightSeq, setHighlightSeq] = useState<number | null>(null);
  const traceId = useId();
  const steps = scenario?.steps ?? [];
  const failed = scenario?.verdict === "FAIL" || scenario?.verdict === "INCONCLUSIVE";

  function showStep(seq: number) {
    setTraceOpen(true);
    setHighlightSeq(seq);
  }

  return (
    <article className="flex h-full flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="font-mono text-xs text-muted">
            {id} · {SCENARIO_TITLES[id] ?? scenario?.title}
          </p>
          <h3 className="text-base font-semibold leading-6" suppressHydrationWarning>
            {scenario ? liveHeadline(scenario, now, deadlineMs) : "Not run yet"}
          </h3>
        </div>
        <VerdictBadge scenario={scenario} />
      </header>

      {(scenario?.reason ?? scenario?.error) && (
        <p className="text-sm leading-6 text-muted">{scenario?.reason ?? scenario?.error}</p>
      )}

      {scenario && failed && <AnalysisPanel scenario={scenario} onStep={showStep} />}

      {steps.length > 0 && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-expanded={traceOpen}
            aria-controls={traceId}
            onClick={() => setTraceOpen((value) => !value)}
            className="-mx-2 min-h-10 self-start rounded-md px-2 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {traceOpen ? "Hide trace" : `Show trace · ${steps.length} steps`}
          </button>
          {traceOpen && (
            <div id={traceId}>
              <TraceGrid steps={steps} highlightSeq={highlightSeq} />
            </div>
          )}
        </div>
      )}

      {scenario?.durationMs !== null && scenario?.durationMs !== undefined && scenario.status === "COMPLETED" && (
        <p className="mt-auto font-mono text-xs text-muted">Finished in {seconds(scenario.durationMs)}</p>
      )}
    </article>
  );
}
