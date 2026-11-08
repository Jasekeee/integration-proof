"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
// useHydrated: false until React has hydrated, so a click never lands on a dead button.
import { useHydrated, useNow, useRunReport } from "./hooks";
import { Odometer, useChanges } from "./motion";
import { ScenarioRows } from "./proof-scenes";
import {
  isRunActive,
  MODE_LABELS,
  runProgress,
  runTone,
  SCENARIO_TITLES,
  verifiedFixes,
  type Mode,
  type RunReport,
  type StoreCode,
} from "./report";
import { buttonPrimary, buttonSmall, linkUtility } from "./ui";

const MODES: Mode[] = ["naive", "hardened"];
const SCENARIO_IDS = Object.keys(SCENARIO_TITLES);
const DEFAULT_DEADLINE_MS = 150_000;

/** Each store's line under its score. */
const CAPTIONS: Record<Mode, string> = { naive: "common mistakes left in", hardened: "mistakes fixed" };
const SCORE_COLORS = { pass: "text-pass", fail: "text-fail", warn: "text-warn" } as const;

/** While following someone else's run: how often the list of runs is read. */
const FOLLOW_POLL_MS = 3000;
/** Polls with no live run before the page calls it over; bridges the gap between their two stores. */
const QUIET_POLLS = 2;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Another visitor's run is live, so this one did not start. */
class RunInProgress extends Error {}

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
 * One store's score in large type. While its run is live, the progress stands in its place: a
 * partial score would read as the final one. The score rolls up when this page saw the run end.
 */
function Tally({ mode, report, now, previous }: { mode: Mode; report: RunReport | null; now: number; previous: boolean }) {
  const active = isRunActive(report);
  const ended = useChanges(active) > 0 && !active;
  const tone = runTone(report);
  const total = report?.summary.total ?? 6;
  const progress = report && active ? runProgress(report, now) : null;
  return (
    <div className={`flex min-w-0 flex-col items-center transition-opacity duration-200 ${previous ? "opacity-60" : ""}`}>
      {progress ? (
        <p className="flex h-[clamp(4rem,9vw,7.5rem)] flex-col items-center justify-center gap-2" aria-live="polite">
          <span className="grid w-40 grid-cols-6 gap-1 sm:w-56" aria-hidden="true">
            {report!.scenarios.map((scenario) => (
              <span
                key={scenario.id}
                className={`segment h-1.5 rounded-full ${scenario.verdict === "PASS" ? "bg-pass" : scenario.verdict === "FAIL" ? "bg-fail" : scenario.verdict ? "bg-warn" : scenario.status === "WAITING_FOR_WEBHOOK" ? "bg-warn-bg" : scenario.status === "RUNNING" ? "bg-[color-mix(in_srgb,var(--brand)_32%,var(--surface-2))]" : "bg-surface-2"}`}
              />
            ))}
          </span>
          <span className="whitespace-nowrap text-base font-medium tabular-nums sm:text-lg" suppressHydrationWarning>
            Running · {progress.done} of {progress.total} done · {progress.elapsedS} s
          </span>
        </p>
      ) : (
        <p className="flex h-[clamp(4rem,9vw,7.5rem)] items-center text-[clamp(4rem,9vw,7.5rem)] font-semibold leading-none tracking-[-0.055em] tabular-nums">
          <span className={`inline-flex h-[1em] ${tone ? SCORE_COLORS[tone] : "text-muted"}`}>
            {report ? <Odometer key={report.id} value={report.summary.passed} max={total} roll={ended} /> : "–"}
            <span>/{total}</span>
          </span>
        </p>
      )}
      <p className="mt-3 text-lg font-medium">{MODE_LABELS[mode].name}</p>
      <p className="text-small text-muted">{previous ? "previous run" : CAPTIONS[mode]}</p>
    </div>
  );
}

/**
 * Both stores side by side, in two layers. The first answers one question in plain words: each
 * store's score and, per scenario, what came of it. A row opens its scene; the technical layer
 * (Claude's analysis, the store code, the AG Grid trace) opens from there.
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

  const fixes = verifiedFixes(reports.naive);
  const fixReport = reports.naive?.scenarios.find((scenario) => scenario.analysis?.fixCheck)?.analysis?.fixCheck?.report;
  const shareable = MODES.filter((mode) => reports[mode] && !isRunActive(reports[mode]) && !previous[mode]);

  return (
    <div className="flex flex-col">
      <header className="flex flex-col items-center pb-8 pt-12 text-center sm:pb-12 sm:pt-16">
        <h1 className="text-[clamp(2.5rem,6vw,4.75rem)] font-semibold leading-[1.04] tracking-display text-balance">
          Six bad days. Two stores.
        </h1>
        <p className="mt-4 text-lg text-pretty text-muted sm:text-xl">Real failures, injected in the PayPal sandbox.</p>
        {freshToken && (
          <p className="measure mt-3 text-sm text-muted">
            Fresh analysis is on: Claude analyses every failure again instead of reusing an earlier analysis.
          </p>
        )}

        <div className="mt-10 grid w-full max-w-2xl grid-cols-2 gap-4">
          {MODES.map((mode) => (
            <Tally key={mode} mode={mode} report={reports[mode]} now={now} previous={previous[mode]} />
          ))}
        </div>

        <p className="mt-8 text-pretty text-muted">
          Code decides every verdict. Claude explains each failure
          {fixes && (
            <>
              {" — "}
              {fixReport ? (
                <a href={fixReport} className={`rounded-sm tabular-nums ${linkUtility}`}>
                  {fixes.verified}/{fixes.total} fixes verified
                </a>
              ) : (
                <span className="tabular-nums">
                  {fixes.verified}/{fixes.total} fixes verified
                </span>
              )}
            </>
          )}
          .
        </p>

        <div className="mt-8">
          {/* While a run is live the button is busy, not broken: it says which store is running. */}
          {running ? (
            <button
              type="button"
              disabled
              aria-busy="true"
              className="inline-flex min-h-12 cursor-progress items-center gap-2.5 rounded-full border border-border-strong bg-background px-6 font-medium"
            >
              <span className="spinner" aria-hidden="true" />
              {runLabel}
            </button>
          ) : (
            <button type="button" onClick={() => run(MODES)} disabled={busy} className={`${buttonPrimary} min-h-12 rounded-full px-6 text-base`}>
              Run both live
              <span className="font-normal opacity-75">about 2–3 min</span>
            </button>
          )}
        </div>

        {/* The line keeps its place, so nothing moves when a wait begins or a run ends. */}
        <p role="status" className="mt-4 flex min-h-10 items-start justify-center gap-2 text-sm text-muted sm:min-h-5">
          {waiting && (
            <>
              <span aria-hidden="true" className="live-dot mt-[7px] size-1.5 shrink-0 rounded-full bg-warn" />
              Waiting for PayPal&apos;s real webhooks. They usually arrive in 7 to 60 seconds.
            </>
          )}
        </p>

        <div className="flex w-full max-w-2xl flex-col gap-3 text-left">
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
        </div>
      </header>

      <ScenarioRows
        ids={SCENARIO_IDS}
        scenariosOf={(id) => ({
          naive: reports.naive?.scenarios.find((scenario) => scenario.id === id) ?? null,
          hardened: reports.hardened?.scenarios.find((scenario) => scenario.id === id) ?? null,
        })}
        now={now}
        deadlineMs={{
          naive: reports.naive?.config.webhookDeadlineMs ?? DEFAULT_DEADLINE_MS,
          hardened: reports.hardened?.config.webhookDeadlineMs ?? DEFAULT_DEADLINE_MS,
        }}
        code={code}
        dimmed={previous}
      />

      {shareable.length > 0 && (
        <p className="pt-6 text-small text-muted">
          Share these results:{" "}
          {shareable.map((mode, index) => (
            <span key={mode}>
              {index > 0 && " · "}
              <Link href={`/proof/${reports[mode]!.id}`} className={`rounded-sm ${linkUtility}`}>
                {MODE_LABELS[mode].name}
              </Link>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
