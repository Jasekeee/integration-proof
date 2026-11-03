"use client";

import { useEffect, useState } from "react";

const MODES = ["naive", "hardened"] as const;
const POLL_MS = 2000;

interface RunState {
  id: string;
  status: string;
}

export function RunConsole() {
  const [run, setRun] = useState<RunState | null>(null);
  const [view, setView] = useState<unknown>(null);
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
      setView(body);
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
        const body = await response.json();
        setView(body);
        if (body.status !== run.status) setRun(body);
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
            Run S1–S2 on the {mode} store
          </button>
        ))}
      </div>
      {error && <p role="alert">{error}</p>}
      {run && (
        <p className="text-sm">
          <a className="underline" href={`/api/runs/${run.id}/report`}>
            Full report with trace
          </a>
        </p>
      )}
      {view !== null && (
        <pre className="overflow-x-auto rounded-md border p-4 font-mono text-xs leading-relaxed">
          {JSON.stringify(view, null, 2)}
        </pre>
      )}
    </section>
  );
}
