"use client";

import { DiffView } from "./diff-view";
import { FixMark } from "./fix-mark";
import { usePlayOnce } from "./motion";
import { Icon } from "./icon";
import { proposedEdits, seconds, selfCheckLabel, type AnalysisView, type ScenarioView } from "./report";
import { linkUtility, panel, panelLabel } from "./ui";

const PATCH_LABELS = { applies: "Patch applies to the store file", needs_review: "Patch needs review", none: null };

/**
 * The offline check of this exact patch. The caption says where the verdict comes from: a
 * deterministic model of PayPal built from sandbox observations, not the live sandbox.
 */
function FixBadge({ check }: { check: NonNullable<AnalysisView["fixCheck"]> }) {
  // The badge plays once, the first time it is seen: the fail, the fix, the pass.
  const [ref, phase] = usePlayOnce<HTMLParagraphElement>();
  const checked = check.before !== null;
  const style = checked ? "bg-warn-bg text-warn" : "bg-surface-2 text-muted";
  return (
    <div className="flex flex-col gap-1.5">
      <p ref={ref} data-fix={check.verified ? phase : undefined}>
        {check.verified ? (
          <FixMark before={check.before ?? "FAIL"} after={check.after ?? "PASS"} label="Fix verified offline" />
        ) : (
          <span className={`inline-flex h-6 items-center rounded-control px-2 text-xs font-semibold ${style}`}>Fix not verified</span>
        )}
      </p>
      <p className="measure text-xs leading-5 text-muted">
        {check.verified
          ? "The patched store passed this scenario on a deterministic model of PayPal built from sandbox observations."
          : `Not verified: ${check.reason}. The offline check runs on a deterministic model of PayPal built from sandbox observations.`}{" "}
        <a href={check.report} className={`rounded-sm ${linkUtility}`}>
          Report
        </a>
      </p>
    </div>
  );
}

/** One part of the analysis: a small label and what Claude wrote under it. */
function Part({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h4 className={panelLabel}>{label}</h4>
      {children}
    </div>
  );
}

const prose = "measure text-sm leading-6 text-pretty";

/**
 * Claude's analysis of one store's FAIL or INCONCLUSIVE verdict, the one place it appears: why it
 * failed, whether the fix was verified, what it costs, the evidence in step order (each opens the
 * trace at its step), the fix with its patch, and how to verify it. As wide as the scenario, so the
 * evidence and the patch have room.
 */
export function ClaudeAnalysis({
  scenario,
  store,
  id,
  onStep,
}: {
  scenario: ScenarioView;
  /** The store's name, for the heading. */
  store: string;
  id: string;
  onStep: (seq: number) => void;
}) {
  const analysis = scenario.analysis;
  const result = analysis?.status === "READY" ? analysis.result : null;
  const why = scenario.verdict === "INCONCLUSIVE" ? "Why it is inconclusive" : "Why it failed";
  const evidence = result ? [...result.evidence].sort((a, b) => a.stepId - b.stepId) : [];
  const selfCheck = result ? selfCheckLabel(result.fix.selfCheck) : null;

  return (
    <section id={id} aria-label={`Claude's analysis, ${store}`} className={`flex min-w-0 scroll-mt-4 flex-col gap-6 ${panel}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-base font-semibold">
          Claude&apos;s analysis · <span className="font-normal text-muted">{store}</span>
        </h3>
        {result && analysis && (
          <span className="text-xs tabular-nums text-muted">
            {result.confidence} confidence · {analysis.reused ? "cached" : seconds(analysis.durationMs)}
            {selfCheck ? ` · ${selfCheck}` : ""}
          </span>
        )}
      </div>

      <div aria-live="polite" className="contents">
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
      </div>

      {result && analysis && (
        <>
          <div className="grid gap-6 lg:grid-cols-2 lg:gap-10">
            <Part label={why}>
              <p className={prose}>{result.rootCause}</p>
              {analysis.fixCheck && <FixBadge check={analysis.fixCheck} />}
            </Part>
            <Part label="What it costs">
              <p className={prose}>{result.businessImpact}</p>
            </Part>
          </div>

          <Part label="Evidence in the trace">
            <ul className="grid gap-x-10 gap-y-2 lg:grid-cols-2">
              {evidence.map((item) => (
                <li key={`${item.stepId}-${item.observation}`} className="flex gap-3 text-sm leading-6">
                  <button
                    type="button"
                    onClick={() => onStep(item.stepId)}
                    className="chip-accent min-h-9 min-w-12 shrink-0 self-start px-2.5 text-xs tabular-nums"
                    aria-label={`Show step ${item.stepId} in the trace`}
                  >
                    #{item.stepId}
                  </button>
                  <span className="pt-2">{item.observation}</span>
                </li>
              ))}
            </ul>
          </Part>

          <Part label="Fix">
            <p className={prose}>{result.fix.summary}</p>
            {(result.fix.patch || (result.fix.edits?.length ?? 0) > 0) && (
              <>
                <p className="text-xs text-muted">
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
                    <a href={doc.url} target="_blank" rel="noreferrer noopener" className={`inline-flex items-center gap-1 rounded-sm ${linkUtility}`}>
                      {doc.title}
                      <Icon name="arrow-up-right" className="size-3.5 text-muted" />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Part>

          <Part label="Verify by">
            <p className={prose}>{result.verifyBy}</p>
          </Part>

          <p className="text-xs tabular-nums text-muted">
            {analysis.model} ·{" "}
            {analysis.reused
              ? "Same failure on the same code: cached analysis, no tokens spent"
              : `${(analysis.tokens.input + analysis.tokens.cacheRead + analysis.tokens.cacheWrite).toLocaleString("en")} input tokens (${analysis.tokens.cacheRead.toLocaleString("en")} cached), ${analysis.tokens.output.toLocaleString("en")} output`}
          </p>
        </>
      )}
    </section>
  );
}
