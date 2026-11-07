"use client";

import Link from "next/link";
import { Fragment } from "react";
import { useHydrated } from "./hooks";
import { Odometer, useChanges } from "./motion";
import {
  cellState,
  FALLBACK_HEADLINES,
  isRunActive,
  MODE_LABELS,
  progressLabel,
  runDate,
  runTone,
  SCENARIO_TITLES,
  seconds,
  verifiedFixes,
  type CellState,
  type Mode,
  type RunReport,
  type ScenarioView,
} from "./report";
import { linkUtility } from "./ui";

const MODES: Mode[] = ["naive", "hardened"];

/** Short column captions; the cards and the share page carry the longer blurbs. */
const CAPTIONS: Record<Mode, string> = { naive: "Common mistakes left in", hardened: "Each mistake fixed" };

const SCORE_COLORS = { pass: "text-pass", fail: "text-fail", warn: "text-warn" } as const;

/** Chip colors per state. The word carries the meaning; the color changes over 200 ms. */
const CHIP_STYLES: Record<CellState, string> = {
  PASS: "bg-pass-bg text-pass",
  FAIL: "bg-fail-bg text-fail",
  INCONCLUSIVE: "bg-warn-bg text-warn",
  WAITING: "bg-warn-bg text-warn",
  RUNNING: "bg-surface-2 text-foreground",
  QUEUED: "bg-surface-2 text-muted",
  ERROR: "bg-surface-2 text-muted",
  "NOT RUN": "bg-surface-2 text-muted",
};

const HEADLINE_STYLES: Partial<Record<CellState, string>> = {
  FAIL: "text-fail",
  INCONCLUSIVE: "text-warn",
  PASS: "text-muted",
};

/** The outcome in a few words: the assertion's own headline, or a stand-in for older runs. */
function cellHeadline(scenario: ScenarioView | null, state: CellState): string {
  if (!scenario) return "";
  if (state === "ERROR") return "Could not run";
  if (state !== "PASS" && state !== "FAIL" && state !== "INCONCLUSIVE") return "";
  if (scenario.headline) return scenario.headline;
  if (state === "INCONCLUSIVE") return "PayPal did not deliver in time";
  return FALLBACK_HEADLINES[scenario.id]?.[state] ?? "";
}

/** Seconds a cell has been waiting for PayPal's webhook, or null when it is not waiting. */
function waitedSeconds(scenario: ScenarioView | null, state: CellState, now: number): number | null {
  if (state !== "WAITING" || !scenario?.waitingSince) return null;
  return Math.max(0, Math.floor((now - Date.parse(scenario.waitingSince)) / 1000));
}

const VERDICTS: CellState[] = ["PASS", "FAIL", "INCONCLUSIVE"];

/** A progress segment per state: live states are tinted, verdicts take their full color. */
const SEGMENT_STYLES: Record<CellState, string> = {
  PASS: "bg-pass",
  FAIL: "bg-fail",
  INCONCLUSIVE: "bg-warn",
  WAITING: "bg-warn-bg shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--warn)_45%,transparent)]",
  RUNNING: "bg-[color-mix(in_srgb,var(--brand)_32%,var(--surface-2))]",
  QUEUED: "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]",
  ERROR: "bg-border-strong",
  "NOT RUN": "bg-surface-2 shadow-[inset_0_0_0_1px_var(--border)]",
};

/** A live run's progress: one segment per scenario in its real state, and how many are done. */
function Progress({ report, now }: { report: RunReport; now: number }) {
  return (
    <span className="flex min-h-10 flex-col justify-center gap-2">
      <span className="grid max-w-56 grid-cols-6 gap-1" aria-hidden="true">
        {report.scenarios.map((scenario) => (
          <span key={scenario.id} className={`segment h-1.5 rounded-full ${SEGMENT_STYLES[cellState(scenario)]}`} />
        ))}
      </span>
      <span className="font-mono text-xs font-semibold tabular-nums sm:text-small" suppressHydrationWarning>
        {progressLabel(report, now)}
      </span>
    </span>
  );
}

function StoreHead({
  mode,
  report,
  now,
  previous,
}: {
  mode: Mode;
  report: RunReport | null;
  now: number;
  previous: boolean;
}) {
  const active = isRunActive(report);
  const tone = runTone(report);
  const total = report?.summary.total ?? 6;
  // The score rolls up only when this page saw the run end; a page that loads with it shows it still.
  const ended = useChanges(active) > 0 && !active;
  // Times are local to the visitor: the server knows only its own time zone, so they appear once
  // the page runs in the browser.
  const hydrated = useHydrated();
  const when = report && hydrated ? runDate(report.createdAt, now) : null;
  return (
    <div
      className={`flex min-w-0 flex-col gap-1 p-3 transition-opacity duration-200 sm:p-4 ${previous ? "opacity-60" : ""}`}
    >
      <span className="font-semibold">{MODE_LABELS[mode].name}</span>
      {report && active ? (
        <Progress report={report} now={now} />
      ) : (
        <span className="flex min-h-10 items-center font-mono text-3xl font-semibold leading-none tracking-tight tabular-nums sm:text-4xl">
          <span className={`inline-flex h-[1em] ${tone ? SCORE_COLORS[tone] : ""}`}>
            {report ? <Odometer key={report.id} value={report.summary.passed} max={total} roll={ended} /> : "–"}
          </span>
          <span className="inline-flex h-[1em] text-muted">/{total}</span>
        </span>
      )}
      <span className="text-xs leading-5 tabular-nums text-muted">
        {!report && "Not run yet"}
        {report && previous && <>Previous run{when && <> · {when}</>}</>}
        {report && !previous && (
          <>
            <span className="max-sm:hidden">{CAPTIONS[mode]}</span>
            {when && (
              <>
                <span className="max-sm:hidden"> · </span>
                {when}
              </>
            )}
            {report.status === "COMPLETED" && report.durationMs !== null && <> · {seconds(report.durationMs)} run</>}
            {report.status === "ERROR" && <span className="text-warn"> · stopped</span>}
            {!active && (
              <>
                {" · "}
                <Link href={`/proof/${report.id}`} className={`rounded-sm ${linkUtility}`}>
                  share
                </Link>
              </>
            )}
          </>
        )}
      </span>
    </div>
  );
}

/**
 * One store's state for one scenario. A state that changes while the page is open enters: the chip's
 * word slides in, a verdict settles, a FAIL leaves a fading red trace (the flagship scenario a ring).
 * Cells further down the matrix start a beat later, so a poll that brings several reads like a board.
 */
function Cell({
  scenario,
  now,
  dimmed,
  row,
  flagship,
}: {
  scenario: ScenarioView | null;
  now: number;
  dimmed: boolean;
  row: number;
  flagship: boolean;
}) {
  const state = cellState(scenario);
  const headline = cellHeadline(scenario, state);
  const changes = useChanges(state);
  const live = changes > 0;
  const verdict = VERDICTS.includes(state);
  const waited = waitedSeconds(scenario, state, now);
  const stagger = { "--stagger": `${row * 40}ms` } as React.CSSProperties;
  return (
    <span
      className={`relative isolate flex min-w-0 items-center gap-3 px-3 py-3 transition-opacity duration-200 sm:px-4 ${dimmed ? "opacity-60" : ""}`}
      style={stagger}
    >
      {live && state === "FAIL" && <span key={`trace-${changes}`} aria-hidden="true" className={flagship ? "cell-ring" : "cell-flash"} />}
      <span
        key={`chip-${changes}`}
        className={`inline-flex h-6 shrink-0 items-center gap-1.5 overflow-hidden rounded-control px-2 font-mono text-label font-semibold tabular-nums ${CHIP_STYLES[state]} transition-colors duration-200 ${live ? "chip-enter" : ""} ${verdict ? "chip-verdict" : ""}`}
      >
        {state === "RUNNING" && <span aria-hidden="true" className="spinner size-2.5" />}
        {state === "WAITING" && <span aria-hidden="true" className="live-dot size-1.5 rounded-full bg-current" />}
        <span className="chip-word" suppressHydrationWarning>
          {waited === null ? state : `WAITING ${waited} s`}
        </span>
      </span>
      {headline && (
        <span
          key={`headline-${changes}`}
          className={`text-small max-md:hidden ${HEADLINE_STYLES[state] ?? "text-muted"} ${live ? "headline-enter" : ""}`}
        >
          {headline}
        </span>
      )}
    </span>
  );
}

/**
 * The whole result above the fold: each scenario a row, each store a column, a chip per cell. A
 * row is a button that opens and scrolls to that scenario's cards. During a run the column's score
 * gives way to its progress, and a column still showing an earlier run says so and steps back.
 */
export function VerdictMatrix({
  reports,
  now,
  previous,
  flagship,
  openRows,
  onRow,
}: {
  reports: Record<Mode, RunReport | null>;
  now: number;
  previous: Record<Mode, boolean>;
  flagship: string;
  /** Scenarios whose cards are unfolded below. */
  openRows: Set<string>;
  onRow: (id: string) => void;
}) {
  const fixes = verifiedFixes(reports.naive);
  const fixReport = reports.naive?.scenarios.find((scenario) => scenario.analysis?.fixCheck)?.analysis?.fixCheck?.report;
  const costs = MODES.flatMap((mode) => {
    const report = reports[mode];
    if (!report || isRunActive(report) || previous[mode] || report.consequences.length === 0) return [];
    return [{ mode, harms: report.consequences }];
  });

  const costsArrived = useChanges(costs.length > 0) > 0;

  return (
    <section aria-labelledby="verdicts" className="overflow-hidden rounded-panel border border-border">
      {/* The section's heading for the outline; the column heads say the same thing on screen. */}
      <h2 id="verdicts" className="sr-only">
        Verdicts
      </h2>
      <div className="grid grid-cols-2 border-b border-border bg-surface md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] md:items-end">
        <div className="p-4 text-xs leading-5 text-muted max-md:hidden">Scenario</div>
        {MODES.map((mode) => (
          <StoreHead key={mode} mode={mode} report={reports[mode]} now={now} previous={previous[mode]} />
        ))}
      </div>

      <ol>
        {Object.keys(SCENARIO_TITLES).map((id, row) => {
          const flag = id === flagship;
          const open = openRows.has(id);
          const scenarioOf = (mode: Mode) => reports[mode]?.scenarios.find((scenario) => scenario.id === id) ?? null;
          return (
            <li key={id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => onRow(id)}
                className={`grid w-full grid-cols-2 items-center text-left transition-colors duration-150 hover:bg-surface focus-visible:-outline-offset-2 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] ${flag ? "bg-[linear-gradient(90deg,var(--flag-bg),transparent_60%)]" : ""}`}
              >
                <span className="col-span-2 flex min-w-0 flex-wrap items-baseline gap-x-2 px-3 pt-3 sm:px-4 md:col-span-1 md:py-3">
                  <span className="font-mono text-label text-muted">{id}</span>
                  <span className="text-sm font-semibold">{SCENARIO_TITLES[id]}</span>
                  {open && (
                    <span className="inline-flex h-5 items-center rounded-full bg-brand-bg px-2 text-label font-medium text-brand">
                      Open
                    </span>
                  )}
                </span>
                {MODES.map((mode) => (
                  <Cell key={mode} scenario={scenarioOf(mode)} now={now} dimmed={previous[mode]} row={row} flagship={flag} />
                ))}
              </button>
            </li>
          );
        })}
      </ol>

      {(costs.length > 0 || fixes) && (
        <div className="flex flex-wrap justify-between gap-x-6 gap-y-2 border-t border-border bg-surface px-3 py-3 text-small tabular-nums text-muted sm:px-4">
          {costs.map(({ mode, harms }) => (
            <span key={mode}>
              {MODE_LABELS[mode].name} cost in this run:{" "}
              <b className="font-semibold text-fail">
                {harms.map((harm, index) => (
                  // Seen live, the items arrive one by one after the score has rolled.
                  <Fragment key={harm}>
                    {index > 0 && " "}
                    <span
                      className={costsArrived ? "harm-enter inline-block" : undefined}
                      style={costsArrived ? { animationDelay: `${700 + index * 110}ms` } : undefined}
                    >
                      {index > 0 && "· "}
                      {harm}
                    </span>
                  </Fragment>
                ))}
              </b>
            </span>
          ))}
          {fixes && !previous.naive && (
            <span>
              Claude&apos;s fixes:{" "}
              {fixReport ? (
                <a href={fixReport} className={`rounded-sm ${linkUtility}`}>
                  {fixes.verified}/{fixes.total} verified offline
                </a>
              ) : (
                `${fixes.verified}/${fixes.total} verified offline`
              )}
            </span>
          )}
        </div>
      )}
    </section>
  );
}
