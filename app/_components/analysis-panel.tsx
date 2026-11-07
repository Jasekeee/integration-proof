"use client";

import { useId, useState } from "react";
import { DiffView } from "./diff-view";
import { proposedEdits, seconds, selfCheckLabel, type AnalysisView, type ScenarioView } from "./report";

const PATCH_LABELS = { applies: "Patch applies to the store file", needs_review: "Patch needs review", none: null };

/**
 * The offline check of this exact patch. The caption says where the verdict comes from: a
 * deterministic model of PayPal built from sandbox observations, not the live sandbox.
 */
function FixBadge({ check }: { check: NonNullable<AnalysisView["fixCheck"]> }) {
  const checked = check.before !== null;
  const style = check.verified ? "bg-pass-bg text-pass" : checked ? "bg-warn-bg text-warn" : "bg-surface-2 text-muted";
  return (
    <div className="flex flex-col gap-1">
      <p>
        <span className={`inline-flex rounded-md px-2 py-1 font-mono text-xs font-semibold ${style}`}>
          {check.verified ? `Fix verified offline: ${check.before} → ${check.after}` : "Fix not verified"}
        </span>
      </p>
      <p className="text-xs leading-5 text-muted">
        {check.verified
          ? "The patched store passed this scenario on a deterministic model of PayPal built from sandbox observations."
          : `Not verified: ${check.reason}. The offline check runs on a deterministic model of PayPal built from sandbox observations.`}{" "}
        <a
          href={check.report}
          className="text-foreground underline underline-offset-4 hover:text-muted focus-visible:outline-2 focus-visible:outline-ring"
        >
          Report
        </a>
      </p>
    </div>
  );
}

/**
 * Claude's explanation of a FAIL or INCONCLUSIVE verdict. The root cause is always visible; the
 * evidence and the fix open on demand. Evidence buttons point at steps of the trace below.
 */
export function AnalysisPanel({ scenario, onStep }: { scenario: ScenarioView; onStep: (seq: number) => void }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const analysis = scenario.analysis;
  const heading = scenario.verdict === "INCONCLUSIVE" ? "Why it is inconclusive" : "Why it failed";
  const result = analysis?.status === "READY" ? analysis.result : null;

  return (
    <section className="flex flex-col gap-3 rounded-md border border-border bg-background p-3" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-sm font-semibold">{heading} — analyzed by Claude</h4>
        {result && analysis && (
          <span className="font-mono text-xs text-muted">
            {result.confidence} confidence · {analysis.reused ? "cached" : seconds(analysis.durationMs)}
            {selfCheckLabel(result.fix.selfCheck) ? ` · ${selfCheckLabel(result.fix.selfCheck)}` : ""}
          </span>
        )}
      </div>

      {(!analysis || analysis.status === "PENDING") && (
        <div className="flex flex-col gap-2" role="status">
          <p className="text-sm text-muted">Analyzing…</p>
          <div className="h-3 w-11/12 rounded bg-surface-2 motion-safe:animate-pulse" />
          <div className="h-3 w-3/4 rounded bg-surface-2 motion-safe:animate-pulse" />
        </div>
      )}

      {analysis?.status === "UNAVAILABLE" && (
        <p className="text-sm text-muted">
          Analysis unavailable: {analysis.error ?? "Claude gave no valid answer"}. The verdict above stands.
        </p>
      )}

      {result && analysis && (
        <>
          <p className="text-sm leading-6">{result.rootCause}</p>
          {analysis.fixCheck && <FixBadge check={analysis.fixCheck} />}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((value) => !value)}
            className="-mx-2 min-h-10 self-start rounded-md px-2 text-sm font-medium underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {open ? "Hide evidence and fix" : "Show evidence and fix"}
          </button>

          {open && (
            <div id={detailsId} className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">What it costs</h5>
                <p className="text-sm leading-6">{result.businessImpact}</p>
              </div>

              <div className="flex flex-col gap-1">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">Evidence in the trace</h5>
                <ul className="flex flex-col gap-2">
                  {result.evidence.map((item) => (
                    <li key={`${item.stepId}-${item.observation}`} className="flex gap-3 text-sm leading-6">
                      <button
                        type="button"
                        onClick={() => onStep(item.stepId)}
                        className="min-h-10 shrink-0 self-start rounded-md border border-border-strong px-2 font-mono text-xs hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring"
                        aria-label={`Show step ${item.stepId} in the trace`}
                      >
                        #{item.stepId}
                      </button>
                      <span className="pt-2">{item.observation}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="flex flex-col gap-2">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">Fix</h5>
                <p className="text-sm leading-6">{result.fix.summary}</p>
                {(result.fix.patch || (result.fix.edits?.length ?? 0) > 0) && (
                  <>
                    <p className="font-mono text-xs text-muted">
                      {PATCH_LABELS[analysis.patchStatus ?? "none"] ?? "Patch"}
                      {analysis.patchStatus === "needs_review" && analysis.patchNote ? `: ${analysis.patchNote}` : ""}
                    </p>
                    {/* A diff when the edits matched; otherwise the edits as Claude wrote them, for review. */}
                    <DiffView patch={result.fix.patch || proposedEdits(result.fix.edits ?? [])} />
                  </>
                )}
                {result.fix.docs.length > 0 && (
                  <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {result.fix.docs.map((doc) => (
                      <li key={doc.url}>
                        <a
                          href={doc.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="underline underline-offset-4 hover:text-muted focus-visible:outline-2 focus-visible:outline-ring"
                        >
                          {doc.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <h5 className="text-xs font-semibold uppercase tracking-wide text-muted">Verify by</h5>
                <p className="text-sm leading-6">{result.verifyBy}</p>
              </div>

              <p className="font-mono text-xs text-muted">
                {analysis.model} ·{" "}
                {analysis.reused
                  ? "Same failure on the same code: cached analysis, no tokens spent"
                  : `${(analysis.tokens.input + analysis.tokens.cacheRead + analysis.tokens.cacheWrite).toLocaleString("en")} input tokens (${analysis.tokens.cacheRead.toLocaleString("en")} cached), ${analysis.tokens.output.toLocaleString("en")} output`}
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
