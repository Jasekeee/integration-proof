"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useNow, useRunReport } from "./hooks";
import { isRunActive, SCENARIO_TITLES, type Mode, type RunReport } from "./report";
import { RunHeader } from "./run-header";
import { ScenarioCard } from "./scenario-card";

const MODES: Mode[] = ["naive", "hardened"];
const SCENARIO_IDS = Object.keys(SCENARIO_TITLES);
const COLUMN = { naive: "lg:col-start-1", hardened: "lg:col-start-2" } as const;
const DEFAULT_DEADLINE_MS = 150_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Both stores side by side. On wide screens each scenario is one row, so S3 of the naive store sits
 * next to S3 of the hardened one; on narrow screens the two columns stack.
 */
export function ProofComparison({ initial, fresh }: { initial: Record<Mode, RunReport | null>; fresh: boolean }) {
  const [runIds, setRunIds] = useState<Record<Mode, string | null>>({
    naive: initial.naive?.id ?? null,
    hardened: initial.hardened?.id ?? null,
  });
  const [seeds, setSeeds] = useState(initial);
  const reports: Record<Mode, RunReport | null> = {
    naive: useRunReport(runIds.naive, seeds.naive),
    hardened: useRunReport(runIds.hardened, seeds.hardened),
  };
  const [phase, setPhase] = useState<"idle" | Mode>("idle");
  const [error, setError] = useState<{ message: string; modes: Mode[] } | null>(null);
  const busy = phase !== "idle" || MODES.some((mode) => isRunActive(reports[mode]));
  const now = useNow(busy);
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  async function start(mode: Mode): Promise<string | null> {
    const response = await fetch(`/api/runs${fresh ? "?fresh=1" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    const body = response ? await response.json().catch(() => null) : null;
    if (!response?.ok || !body?.id) {
      throw new Error(body?.message ?? "The run could not start. Check your connection and try again.");
    }
    setSeeds((current) => ({ ...current, [mode]: body }));
    setRunIds((current) => ({ ...current, [mode]: body.id }));
    return body.id;
  }

  async function waitForRun(runId: string) {
    while (!unmounted.current) {
      await sleep(2000);
      const response = await fetch(`/api/runs/${runId}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      }).catch(() => null);
      const body = response?.ok ? await response.json().catch(() => null) : null;
      if (body?.status === "COMPLETED" || body?.status === "ERROR") return;
    }
  }

  /** One run at a time, as the service allows: the next store starts when the previous is done. */
  async function run(modes: Mode[]) {
    setError(null);
    try {
      for (const mode of modes) {
        setPhase(mode);
        const runId = await start(mode);
        if (runId) await waitForRun(runId);
        if (unmounted.current) return;
      }
    } catch (cause) {
      setError({ message: cause instanceof Error ? cause.message : String(cause), modes });
    }
    setPhase("idle");
  }

  const primaryLabel =
    phase === "naive" ? "Running the naive store…" : phase === "hardened" ? "Running the hardened store…" : "Run both";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted">
            Runs the naive store, then the hardened one: one run at a time, about a minute each.
          </p>
          {fresh && (
            <p className="text-sm text-muted">
              Fresh analysis is on: Claude analyses every failure again instead of reusing an earlier analysis.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => run(MODES)}
          disabled={busy}
          className="min-h-11 shrink-0 rounded-md bg-accent px-5 text-sm font-semibold text-accent-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {primaryLabel}
        </button>
      </div>

      {error && (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-fail/40 bg-fail-bg p-4 text-fail sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">{error.message}</p>
          <button
            type="button"
            onClick={() => run(error.modes)}
            disabled={busy}
            className="min-h-10 shrink-0 self-start rounded-md border border-current px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50 sm:self-auto"
          >
            Try again
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2 lg:gap-x-6">
        {MODES.map((mode) => {
          const report = reports[mode];
          const deadlineMs = report?.config.webhookDeadlineMs ?? DEFAULT_DEADLINE_MS;
          return (
            <Fragment key={mode}>
              <div
                className={`${COLUMN[mode]} lg:[grid-row:1] ${mode === "hardened" ? "max-lg:mt-6" : ""}`}
              >
                <RunHeader
                  mode={mode}
                  report={report}
                  now={now}
                  action={
                    <button
                      type="button"
                      onClick={() => run([mode])}
                      disabled={busy}
                      className="min-h-10 shrink-0 rounded-md border border-border-strong px-3 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {report ? "Run again" : "Run"}
                    </button>
                  }
                />
              </div>
              {SCENARIO_IDS.map((id, index) => (
                <div
                  key={`${mode}-${id}`}
                  className={`${COLUMN[mode]} lg:[grid-row:var(--row)]`}
                  style={{ "--row": index + 2 } as React.CSSProperties}
                >
                  <ScenarioCard
                    id={id}
                    scenario={report?.scenarios.find((scenario) => scenario.id === id) ?? null}
                    now={now}
                    deadlineMs={deadlineMs}
                  />
                </div>
              ))}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}
