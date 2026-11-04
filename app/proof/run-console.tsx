"use client";

import { useEffect, useState } from "react";

const MODES = ["naive", "hardened"] as const;
const POLL_MS = 2000;
/** How long the page keeps polling for analyses after the run has finished. */
const ANALYSIS_POLL_LIMIT_MS = 10 * 60_000;

type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

interface Step {
  seq: number;
  actor: string;
  method: string | null;
  path: string | null;
  httpStatus: number | null;
  durationMs: number;
  fault: string | null;
  note: string | null;
}

interface AnalysisView {
  status: "PENDING" | "READY" | "UNAVAILABLE";
  reused: boolean;
  model: string;
  durationMs: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  patchStatus: "applies" | "needs_review" | "none" | null;
  patchNote: string | null;
  error: string | null;
  result: {
    rootCause: string;
    businessImpact: string;
    evidence: { stepId: number; observation: string }[];
    fix: { summary: string; patch: string; docs: { title: string; url: string }[] };
    verifyBy: string;
    confidence: "low" | "medium" | "high";
  } | null;
}

interface ScenarioView {
  id: string;
  title: string;
  passWhen: string | null;
  status: string;
  statusLabel: string;
  waitingSince: string | null;
  verdict: Verdict | null;
  reason: string | null;
  error: string | null;
  durationMs: number | null;
  analysis: AnalysisView | null;
  steps?: Step[];
}

interface RunView {
  id: string;
  mode: string;
  status: string;
  durationMs: number | null;
  finishedAt: string | null;
  config: { webhookDeadlineMs: number };
  summary: { total: number; passed: number; failed: number; inconclusive: number; errors: number };
  scenarios: ScenarioView[];
}

function seconds(ms: number | null): string {
  return ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`;
}

function needsAnalysis(scenario: ScenarioView): boolean {
  return scenario.verdict === "FAIL" || scenario.verdict === "INCONCLUSIVE";
}

function analysisSettled(scenario: ScenarioView): boolean {
  return !needsAnalysis(scenario) || (scenario.analysis !== null && scenario.analysis.status !== "PENDING");
}

export function RunConsole() {
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  async function start(mode: (typeof MODES)[number]) {
    setStarting(true);
    setError(null);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? `HTTP ${response.status}`);
      setRun(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  }

  const active = run !== null && (run.status === "QUEUED" || run.status === "RUNNING");
  const finishedAt = run?.finishedAt ? Date.parse(run.finishedAt) : null;
  const analysing =
    run !== null &&
    !active &&
    !run.scenarios.every(analysisSettled) &&
    (finishedAt === null || now - finishedAt < ANALYSIS_POLL_LIMIT_MS);

  useEffect(() => {
    if (!run || (!active && !analysing)) return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/runs/${run.id}/report`, { cache: "no-store" });
        if (response.ok) setRun(await response.json());
      } catch {
        // The next poll tries again.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [run, active, analysing]);

  // A one-second clock for the time spent waiting for PayPal's webhooks.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        {MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => start(mode)}
            disabled={starting || active}
            className="rounded-md border border-current px-4 py-2 text-sm font-medium disabled:opacity-40"
          >
            Run full proof on the {mode} store
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      {run && (
        <>
          <p className="text-sm" aria-live="polite">
            {run.mode} store: {active ? "running" : run.status.toLowerCase()} · {run.summary.passed} of{" "}
            {run.summary.total} passed · {run.summary.failed} failed
            {run.summary.inconclusive > 0 ? ` · ${run.summary.inconclusive} inconclusive` : ""}
            {run.summary.errors > 0 ? ` · ${run.summary.errors} could not run` : ""} · {seconds(run.durationMs)}
            {analysing ? " · Claude is analysing the failures" : ""}
          </p>
          <ul className="flex flex-col gap-3">
            {run.scenarios.map((scenario) => (
              <ScenarioCard
                key={scenario.id}
                scenario={scenario}
                deadlineMs={run.config.webhookDeadlineMs}
                now={now}
              />
            ))}
          </ul>
          <p className="text-sm">
            <a className="underline" href={`/api/runs/${run.id}/report`}>
              Full report as JSON
            </a>
          </p>
        </>
      )}
    </section>
  );
}

function ScenarioCard({ scenario, deadlineMs, now }: { scenario: ScenarioView; deadlineMs: number; now: number }) {
  const [traceOpen, setTraceOpen] = useState(false);
  const waiting =
    scenario.status === "WAITING_FOR_WEBHOOK" && scenario.waitingSince
      ? ` · ${Math.max(0, Math.floor((now - Date.parse(scenario.waitingSince)) / 1000))} s of ${deadlineMs / 1000} s`
      : "";

  function showStep(seq: number) {
    setTraceOpen(true);
    requestAnimationFrame(() =>
      document.getElementById(`trace-${scenario.id}-${seq}`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  }

  return (
    <li className="flex flex-col gap-3 rounded-md border border-current/40 px-4 py-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">
          {scenario.id} · {scenario.title}
        </span>
        <span className="font-mono text-xs">
          {scenario.verdict ?? `${scenario.statusLabel}${waiting}`} · {seconds(scenario.durationMs)}
        </span>
      </div>
      {(scenario.reason ?? scenario.error) && <p className="opacity-80">{scenario.reason ?? scenario.error}</p>}
      {needsAnalysis(scenario) && (
        <AnalysisBlock scenario={scenario} onStep={showStep} />
      )}
      {scenario.steps && scenario.steps.length > 0 && (
        <details open={traceOpen} onToggle={(event) => setTraceOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer">Trace ({scenario.steps.length} steps)</summary>
          <ol className="mt-2 flex flex-col gap-1 font-mono text-xs">
            {scenario.steps.map((step) => (
              <li key={step.seq} id={`trace-${scenario.id}-${step.seq}`} className="scroll-mt-24 target:font-semibold">
                #{step.seq} {step.actor} {step.method ?? ""} {step.path ?? ""} {step.httpStatus ?? ""} ·{" "}
                {step.durationMs} ms{step.fault ? ` · ${step.fault}` : ""}
                {step.note ? <span className="block pl-6 opacity-70">{step.note}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      )}
    </li>
  );
}

function AnalysisBlock({ scenario, onStep }: { scenario: ScenarioView; onStep: (seq: number) => void }) {
  const analysis = scenario.analysis;
  const heading = scenario.verdict === "INCONCLUSIVE" ? "Why it is inconclusive" : "Why it failed";

  return (
    <section className="flex flex-col gap-2 rounded-md border border-current/25 p-3" aria-live="polite">
      <h3 className="font-medium">{heading} — analyzed by Claude</h3>
      {(!analysis || analysis.status === "PENDING") && <p className="opacity-80">Analyzing…</p>}
      {analysis?.status === "UNAVAILABLE" && (
        <p className="opacity-80">
          Analysis unavailable: {analysis.error ?? "no valid answer"}. The verdict above stands.
        </p>
      )}
      {analysis?.status === "READY" && analysis.result && (
        <>
          <p>{analysis.result.rootCause}</p>
          <p className="opacity-80">{analysis.result.businessImpact}</p>
          <div>
            <p className="font-medium">Evidence</p>
            <ul className="flex flex-col gap-1">
              {analysis.result.evidence.map((item) => (
                <li key={`${item.stepId}-${item.observation}`}>
                  <a
                    href={`#trace-${scenario.id}-${item.stepId}`}
                    onClick={() => onStep(item.stepId)}
                    className="font-mono underline"
                  >
                    step #{item.stepId}
                  </a>{" "}
                  {item.observation}
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-1">
            <p className="font-medium">Fix</p>
            <p>{analysis.result.fix.summary}</p>
            {analysis.result.fix.patch && (
              <>
                <p className="font-mono text-xs">
                  {analysis.patchStatus === "applies" ? "Patch applies" : "Patch needs review"}
                  {analysis.patchNote ? `: ${analysis.patchNote}` : ""}
                </p>
                <pre className="overflow-x-auto rounded-md border border-current/25 p-3 font-mono text-xs leading-relaxed">
                  <code>{analysis.result.fix.patch}</code>
                </pre>
              </>
            )}
            {analysis.result.fix.docs.length > 0 && (
              <ul className="flex flex-wrap gap-x-4 gap-y-1">
                {analysis.result.fix.docs.map((doc) => (
                  <li key={doc.url}>
                    <a className="underline" href={doc.url} target="_blank" rel="noreferrer noopener">
                      {doc.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p>
            <span className="font-medium">Verify by: </span>
            {analysis.result.verifyBy}
          </p>
          <p className="font-mono text-xs opacity-70">
            Confidence {analysis.result.confidence} · {analysis.model} ·{" "}
            {analysis.reused
              ? "reused from an earlier run with the same failure, no tokens spent"
              : `${seconds(analysis.durationMs)} · ${analysis.tokens.input + analysis.tokens.cacheRead + analysis.tokens.cacheWrite} input tokens (${analysis.tokens.cacheRead} cached), ${analysis.tokens.output} output tokens`}
          </p>
        </>
      )}
    </section>
  );
}
