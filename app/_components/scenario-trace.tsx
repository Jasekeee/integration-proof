"use client";

import dynamic from "next/dynamic";
import { useId, useState } from "react";
import { TraceText } from "./trace-text";
import { MODE_LABELS, retriedWithSameKey, SCENARIO_TITLES, traceRow, type Mode, type StepView } from "./report";
import { buttonSmall, buttonText, panel } from "./ui";

// AG Grid needs the browser; it loads when a trace is first opened. Until then a placeholder holds
// about the grid's height (--trace-height, set by ScenarioTrace), so the page does not jump.
const TraceGrid = dynamic(() => import("./trace-grid"), {
  ssr: false,
  loading: () => <div className="h-(--trace-height) rounded-card bg-surface motion-safe:animate-pulse" />,
});

/** The grid's header and its rows, roughly: rows grow when a call wraps. */
const traceHeight = (steps: number) => `${49 + steps * 42}px`;

/** A body as the report holds it, already redacted on the server before it was stored. */
function Body({ label, value }: { label: string; value: unknown }) {
  const text = value === null || value === undefined ? null : JSON.stringify(value, null, 2);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h5 className="text-small text-muted">{label}</h5>
      {text ? (
        <pre
          tabIndex={0}
          aria-label={label}
          className="max-h-80 overflow-auto rounded-card border border-hairline bg-sunken p-3 font-mono text-xs leading-5"
        >
          {text}
        </pre>
      ) : (
        <p className="rounded-control border border-dashed border-border p-3 text-sm text-muted">No body</p>
      )}
    </div>
  );
}

/** The request and response of one step, with its full ids: part of the trace's panel, not a box of its own. */
function StepBodies({ step, onClose }: { step: StepView; onClose: () => void }) {
  const row = traceRow(step);
  return (
    <section
      aria-label={`Step ${step.seq}: request and response`}
      className="flex flex-col gap-3 border-t border-border pt-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h4 className="break-words text-sm font-semibold tabular-nums">
            Step {step.seq} ·{" "}
            <span className="inline-block align-top font-mono">
              <TraceText text={row.call} />
            </span>
            {step.httpStatus !== null ? ` · ${step.httpStatus}` : ""}
          </h4>
          <p className="break-words text-xs text-muted">
            debug_id <span className="font-mono">{step.debugId ?? "–"}</span> · PayPal-Request-Id{" "}
            <span className="font-mono">{step.paypalRequestId ?? "—"}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`${buttonSmall} shrink-0`}
        >
          Close
        </button>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Body label="Request body" value={step.requestBody} />
        <Body label="Response body" value={step.responseBody} />
      </div>
      <p className="text-xs leading-5 text-muted">
        Bodies are redacted before they are stored: card numbers, security codes, tokens and run keys read [REDACTED].
      </p>
    </section>
  );
}

/**
 * One store's trace for one scenario, as wide as the scenario, in a panel: the grid, and below it the
 * redacted request and response of the step a click opened.
 */
export function ScenarioTrace({
  id,
  mode,
  steps,
  highlightSeq,
  domId,
  onClose,
}: {
  id: string;
  mode: Mode;
  steps: StepView[];
  highlightSeq: number | null;
  domId: string;
  onClose: () => void;
}) {
  const [selectedSeq, setSelectedSeq] = useState<number | null>(null);
  const headingId = useId();
  const selected = steps.find((step) => step.seq === selectedSeq) ?? null;
  const sameKey = id === "S2" && mode === "hardened" && retriedWithSameKey(steps);

  return (
    <section
      id={domId}
      aria-labelledby={headingId}
      className={`trace-enter flex min-w-0 scroll-mt-4 flex-col gap-4 ${panel}`}
      style={{ "--trace-height": traceHeight(steps.length) } as React.CSSProperties}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={headingId} className="text-base font-semibold">
          Trace · <span className="font-normal text-muted">{MODE_LABELS[mode].name}, {steps.length} steps</span>
          <span className="sr-only">, {id} · {SCENARIO_TITLES[id]}</span>
        </h3>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted sm:inline">Click a step for its request and response</span>
          <button
            type="button"
            onClick={onClose}
            className={buttonText}
          >
            Hide trace
          </button>
        </div>
      </div>
      <TraceGrid
        steps={steps}
        highlightSeq={highlightSeq}
        selectedSeq={selectedSeq}
        onSelect={(seq) => setSelectedSeq((current) => (current === seq ? null : seq))}
      />
      {sameKey && (
        <p className="rounded-control border border-pass/30 bg-pass-bg px-3 py-2 text-sm font-medium text-pass">
          Same PayPal-Request-Id on both attempts: the retry cannot charge twice.
        </p>
      )}
      {selected && <StepBodies step={selected} onClose={() => setSelectedSeq(null)} />}
    </section>
  );
}
