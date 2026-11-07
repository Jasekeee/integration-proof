"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useNow, useRunReport } from "./hooks";
import { FLAGSHIP_SCENARIO, isRunActive, MODE_LABELS, SCENARIO_TITLES, type Mode, type RunReport, type StoreCode } from "./report";
import { ScenarioSection, sectionId } from "./scenario-section";
import { buttonPrimary, buttonSmall } from "./ui";
import { VerdictMatrix } from "./verdict-matrix";

const MODES: Mode[] = ["naive", "hardened"];
const SCENARIO_IDS = Object.keys(SCENARIO_TITLES);
const DEFAULT_DEADLINE_MS = 150_000;

type Unfolded = Record<string, Record<Mode, boolean>>;
const BOTH = { naive: true, hardened: true };

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
  createdAt: string;
}

/** The newest runs, newest first, or null when they could not be read this time. */
async function latestRuns(): Promise<RunSummary[] | null> {
  const response = await fetch("/api/runs", { cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  const body = response?.ok ? await response.json().catch(() => null) : null;
  return Array.isArray(body?.runs) ? (body.runs as RunSummary[]) : null;
}

/**
 * Both stores side by side: the verdict matrix on top, then each scenario's cards. On wide screens
 * S3 of the naive store sits next to S3 of the hardened one; on narrow screens the two cards stack.
 */
export function ProofComparison({
  initial,
  freshToken,
  code,
  loadError = false,
}: {
  initial: Record<Mode, RunReport | null>;
  /** The operator's token for live analysis, already checked by the server; null otherwise. */
  freshToken: string | null;
  code: StoreCode;
  loadError?: boolean;
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
  /** Stores this visitor's run will reach but has not started yet: their column shows a previous run. */
  const [queued, setQueued] = useState<Mode[]>([]);
  /** While following: when the earliest live run of theirs was created; older columns are previous. */
  const [followSince, setFollowSince] = useState<string | null>(null);
  /** The flagship scenario opens unfolded; a click on a matrix row unfolds its cards. */
  const [unfolded, setUnfolded] = useState<Unfolded>({ [FLAGSHIP_SCENARIO]: BOTH });
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

  const previous: Record<Mode, boolean> = { naive: false, hardened: false };
  for (const mode of MODES) {
    const report = reports[mode];
    if (!report || isRunActive(report)) continue;
    previous[mode] = queued.includes(mode) || (following && followSince !== null && report.createdAt < followSince);
  }
  // A proof runs the naive store first: while it is live, an older hardened run is the previous one,
  // also for a visitor who opened the page in the middle of someone else's run.
  const naive = reports.naive;
  const hardened = reports.hardened;
  if (naive && hardened && isRunActive(naive) && !isRunActive(hardened) && hardened.createdAt < naive.createdAt) {
    previous.hardened = true;
  }
  const waiting = MODES.some(
    (mode) => isRunActive(reports[mode]) && reports[mode]?.scenarios.some((scenario) => scenario.status === "WAITING_FOR_WEBHOOK"),
  );

  function openRow(id: string) {
    setUnfolded((current) => ({ ...current, [id]: BOTH }));
    requestAnimationFrame(() => {
      const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      document.getElementById(sectionId(id))?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" });
    });
  }

  function toggle(id: string, mode: Mode) {
    setUnfolded((current) => {
      const row = current[id] ?? { naive: false, hardened: false };
      return { ...current, [id]: { ...row, [mode]: !row[mode] } };
    });
  }

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
    setQueued((current) => current.filter((candidate) => candidate !== mode));
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
        const live = runs.filter((candidate) => candidate.status === "QUEUED" || candidate.status === "RUNNING");
        const earliest = live.map((candidate) => candidate.createdAt).sort()[0];
        if (earliest) setFollowSince((current) => (current && current <= earliest ? current : earliest));
        quiet = live.length > 0 ? 0 : quiet + 1;
      }
      if (quiet < QUIET_POLLS) await sleep(FOLLOW_POLL_MS);
    }
    if (!unmounted.current) {
      setFollowing(false);
      setFollowSince(null);
    }
  }

  /** One run at a time, as the service allows: the next store starts when the previous is done. */
  async function run(modes: Mode[]) {
    setError(null);
    setQueued(modes);
    try {
      for (const mode of modes) {
        setPhase(mode);
        const runId = await start(mode);
        if (runId) await waitForRun(runId);
        if (unmounted.current) return;
      }
    } catch (cause) {
      setQueued([]);
      if (cause instanceof RunInProgress) {
        setPhase("idle");
        await follow();
        return;
      }
      setError({ message: cause instanceof Error ? cause.message : String(cause), modes });
    }
    setQueued([]);
    setPhase("idle");
  }

  const running = phase !== "idle" || following || MODES.some((mode) => isRunActive(reports[mode]));
  /** The store whose run is live now: this visitor's, or the one being followed. */
  const liveMode = phase !== "idle" ? phase : MODES.find((mode) => isRunActive(reports[mode]));
  const runLabel = liveMode ? `Running ${MODE_LABELS[liveMode].name.toLowerCase()}` : "Running…";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight">Six failures, two stores</h1>
          <p className="measure leading-relaxed text-pretty text-muted">
            The same PayPal failures, injected in the sandbox, against a store with common mistakes and the same store
            fixed. Code decides every verdict. Claude explains each failure.
          </p>
          {freshToken && (
            <p className="measure text-sm text-muted">
              Fresh analysis is on: Claude analyses every failure again instead of reusing an earlier analysis.
            </p>
          )}
        </div>
        {/* While a run is live the button is busy, not broken: it says which store is running. */}
        {running ? (
          <button
            type="button"
            disabled
            aria-busy="true"
            className="inline-flex min-h-11 shrink-0 cursor-progress items-center gap-2.5 self-start rounded-control border border-border-strong bg-surface px-5 text-sm font-semibold sm:self-auto"
          >
            <span className="spinner" aria-hidden="true" />
            {runLabel}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => run(MODES)}
            disabled={busy}
            className={`${buttonPrimary} shrink-0 self-start sm:self-auto`}
          >
            Run both live
            <span className="font-normal opacity-75">about 2–3 min</span>
          </button>
        )}
      </header>

      {loadError && (
        <p role="alert" className="rounded-card border border-warn/40 bg-warn-bg p-4 text-sm text-warn">
          The latest results could not be loaded. Running the proof still works; reload the page to try again.
        </p>
      )}

      {following && (
        <div role="status" className="rounded-card border border-border-strong bg-surface p-4 text-sm leading-6">
          Another visitor is running the proof right now, so yours did not start. Their run is shown below as it
          happens; you can run it again as soon as it finishes.
        </div>
      )}

      {error && (
        <div role="alert" className="flex flex-col gap-3 rounded-card border border-fail/40 bg-fail-bg p-4 text-fail sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm">{error.message}</p>
          <button
            type="button"
            onClick={() => run(error.modes)}
            disabled={busy}
            className={`${buttonSmall} shrink-0 self-start border-current bg-transparent text-fail hover:border-current hover:bg-background/40 sm:self-auto`}
          >
            Try again
          </button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        {/* The line keeps its place for the whole run, so the matrix does not jump when a wait begins. A wait is
            normal, so the line is plain; the amber dot marks what is waiting, like the cells below. */}
        <p role="status" className={`flex items-start gap-2 text-sm text-muted ${waiting || running ? "min-h-10 sm:min-h-5" : "sr-only"}`}>
          {waiting && (
            <>
              <span aria-hidden="true" className="mt-[7px] size-1.5 shrink-0 rounded-full bg-warn" />
              Waiting for PayPal&apos;s real webhooks. They usually arrive in 7 to 60 seconds.
            </>
          )}
        </p>
        <VerdictMatrix
          reports={reports}
          now={now}
          previous={previous}
          flagship={FLAGSHIP_SCENARIO}
          openRows={new Set(Object.keys(unfolded).filter((id) => unfolded[id].naive || unfolded[id].hardened))}
          onRow={openRow}
        />
      </div>

      <div className="flex flex-col gap-4">
        {SCENARIO_IDS.map((id) => (
          <ScenarioSection
            key={id}
            id={id}
            modes={MODES}
            scenarios={{
              naive: reports.naive?.scenarios.find((scenario) => scenario.id === id) ?? null,
              hardened: reports.hardened?.scenarios.find((scenario) => scenario.id === id) ?? null,
            }}
            now={now}
            deadlineMs={{
              naive: reports.naive?.config.webhookDeadlineMs ?? DEFAULT_DEADLINE_MS,
              hardened: reports.hardened?.config.webhookDeadlineMs ?? DEFAULT_DEADLINE_MS,
            }}
            code={code}
            expanded={unfolded[id] ?? { naive: false, hardened: false }}
            onToggle={(mode) => toggle(id, mode)}
            dimmed={previous}
          />
        ))}
      </div>
    </div>
  );
}
