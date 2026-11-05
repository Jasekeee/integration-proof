"use client";

import { Fragment, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNow, useRunReport } from "./hooks";
import { isRunActive, SCENARIO_TITLES, type Mode, type RunReport, type StoreCode } from "./report";
import { RunHeader } from "./run-header";
import { ScenarioCard } from "./scenario-card";

const MODES: Mode[] = ["naive", "hardened"];
const SCENARIO_IDS = Object.keys(SCENARIO_TITLES);
const COLUMN = { naive: "lg:col-start-1", hardened: "lg:col-start-2" } as const;
const DEFAULT_DEADLINE_MS = 150_000;

/** While following someone else's run: how often the list of runs is read. */
const FOLLOW_POLL_MS = 3000;
/** Polls with no live run before the page calls it over; bridges the gap between their two stores. */
const QUIET_POLLS = 2;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Another visitor's run is live, so this one did not start. */
class RunInProgress extends Error {}

/** False on the server and until React has hydrated, so a click never lands on a dead button. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

interface RunSummary {
  id: string;
  mode: Mode;
  status: RunReport["status"];
}

/** The newest runs, newest first, or null when they could not be read this time. */
async function latestRuns(): Promise<RunSummary[] | null> {
  const response = await fetch("/api/runs", { cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const body = response?.ok ? await response.json().catch(() => null) : null;
  return Array.isArray(body?.runs) ? (body.runs as RunSummary[]) : null;
}

/**
 * Both stores side by side. On wide screens each scenario is one row, so S3 of the naive store sits
 * next to S3 of the hardened one; on narrow screens the two columns stack.
 */
export function ProofComparison({
  initial,
  freshToken,
  code,
}: {
  initial: Record<Mode, RunReport | null>;
  /** The operator's token for live analysis, already checked by the server; null otherwise. */
  freshToken: string | null;
  code: StoreCode;
}) {
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
  /** Following another visitor's run, live, instead of starting one. */
  const [following, setFollowing] = useState(false);
  const hydrated = useHydrated();
  const busy = !hydrated || following || phase !== "idle" || MODES.some((mode) => isRunActive(reports[mode]));
  const now = useNow(busy);
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
    };
  }, []);

  async function start(mode: Mode): Promise<string | null> {
    const response = await fetch(`/api/runs${freshToken ? `?fresh=${encodeURIComponent(freshToken)}` : ""}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    const body = response ? await response.json().catch(() => null) : null;
    if (response?.status === 429 && body?.error === "run_in_progress") throw new RunInProgress();
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

  /**
   * Shows another visitor's run as it happens: each column follows the newest run of its store,
   * which picks up their hardened run after their naive one. Ends once no run has been live for a
   * few polls in a row, and the page is free again.
   */
  async function follow() {
    setFollowing(true);
    let quiet = 0;
    while (!unmounted.current && quiet < QUIET_POLLS) {
      const runs = await latestRuns();
      if (runs) {
        const newest = (mode: Mode) => runs.find((candidate) => candidate.mode === mode)?.id ?? null;
        setRunIds((current) => {
          const next = { naive: newest("naive") ?? current.naive, hardened: newest("hardened") ?? current.hardened };
          return next.naive === current.naive && next.hardened === current.hardened ? current : next;
        });
        const live = runs.some((candidate) => candidate.status === "QUEUED" || candidate.status === "RUNNING");
        quiet = live ? 0 : quiet + 1;
      }
      if (quiet < QUIET_POLLS) await sleep(FOLLOW_POLL_MS);
    }
    if (!unmounted.current) setFollowing(false);
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
      if (cause instanceof RunInProgress) {
        setPhase("idle");
        await follow();
        return;
      }
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
          {freshToken && (
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

      {following && (
        <div role="status" className="rounded-lg border border-border-strong bg-surface p-4 text-sm leading-6">
          Another visitor is running the proof right now, so yours did not start. Their run is shown below as it
          happens; you can run it again as soon as it finishes.
        </div>
      )}

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
                className={`${COLUMN[mode]} min-w-0 lg:[grid-row:1] ${mode === "hardened" ? "max-lg:mt-6" : ""}`}
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
                  className={`${COLUMN[mode]} min-w-0 lg:[grid-row:var(--row)]`}
                  style={{ "--row": index + 2 } as React.CSSProperties}
                >
                  <ScenarioCard
                    id={id}
                    mode={mode}
                    scenario={report?.scenarios.find((scenario) => scenario.id === id) ?? null}
                    now={now}
                    deadlineMs={deadlineMs}
                    code={code}
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
