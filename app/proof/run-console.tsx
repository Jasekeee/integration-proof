"use client";

import { useEffect, useState } from "react";

const MODES = ["naive", "hardened"] as const;
const POLL_MS = 2000;

interface ScenarioView {
  id: string;
  title: string;
  statusLabel: string;
  verdict: "PASS" | "FAIL" | null;
  reason: string | null;
  error: string | null;
  durationMs: number | null;
}

interface RunView {
  id: string;
  mode: string;
  status: string;
  durationMs: number | null;
  summary: { total: number; passed: number; failed: number; errors: number };
  scenarios: ScenarioView[];
}

function seconds(ms: number | null): string {
  return ms === null ? "–" : `${(ms / 1000).toFixed(1)} s`;
}

export function RunConsole() {
  const [run, setRun] = useState<RunView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

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

  useEffect(() => {
    if (!run || !active) return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`/api/runs/${run.id}`, { cache: "no-store" });
        if (response.ok) setRun(await response.json());
      } catch {
        // The next poll tries again.
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [run, active]);

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
            {run.summary.total} passed
            {run.summary.errors > 0 ? ` · ${run.summary.errors} could not be judged` : ""} · {seconds(run.durationMs)}
          </p>
          <ul className="flex flex-col divide-y divide-current/20 rounded-md border border-current/40 text-sm">
            {run.scenarios.map((scenario) => (
              <li key={scenario.id} className="flex flex-col gap-1 px-4 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {scenario.id} · {scenario.title}
                  </span>
                  <span className="font-mono text-xs">
                    {scenario.verdict ?? scenario.statusLabel} · {seconds(scenario.durationMs)}
                  </span>
                </div>
                {(scenario.reason ?? scenario.error) && <p className="opacity-80">{scenario.reason ?? scenario.error}</p>}
              </li>
            ))}
          </ul>
          <p className="text-sm">
            <a className="underline" href={`/api/runs/${run.id}/report`}>
              Full report with trace
            </a>
          </p>
          <details className="text-sm">
            <summary className="cursor-pointer">Run status as JSON</summary>
            <pre className="mt-2 overflow-x-auto rounded-md border p-4 font-mono text-xs leading-relaxed">
              {JSON.stringify(run, null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
