import Link from "next/link";
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

function chipLabel(scenario: ScenarioView | null, state: CellState, now: number): string {
  if (state === "WAITING" && scenario?.waitingSince) {
    return `WAITING ${Math.max(0, Math.floor((now - Date.parse(scenario.waitingSince)) / 1000))} s`;
  }
  return state;
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
  return (
    <div
      className={`flex min-w-0 flex-col gap-1 p-3 transition-opacity duration-200 sm:p-4 ${previous ? "opacity-60" : ""}`}
    >
      <span className="font-semibold">{MODE_LABELS[mode].name}</span>
      {report && active ? (
        <span className="flex min-h-10 items-center font-mono text-sm font-semibold tabular-nums sm:text-base" suppressHydrationWarning>
          {progressLabel(report, now)}
        </span>
      ) : (
        <span className="flex min-h-10 items-center font-mono text-3xl font-semibold leading-none tracking-tight tabular-nums sm:text-4xl">
          <span className={tone ? SCORE_COLORS[tone] : undefined}>{report ? report.summary.passed : "–"}</span>
          <span className="text-muted">/{total}</span>
        </span>
      )}
      <span className="text-xs leading-5 tabular-nums text-muted" suppressHydrationWarning>
        {!report && "Not run yet"}
        {report && previous && <>Previous run · {runDate(report.createdAt, now)}</>}
        {report && !previous && (
          <>
            <span className="max-sm:hidden">{CAPTIONS[mode]} · </span>
            {runDate(report.createdAt, now)}
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

function Cell({ scenario, now, dimmed }: { scenario: ScenarioView | null; now: number; dimmed: boolean }) {
  const state = cellState(scenario);
  const headline = cellHeadline(scenario, state);
  return (
    <span
      className={`flex min-w-0 items-center gap-3 px-3 py-3 transition-opacity duration-200 sm:px-4 ${dimmed ? "opacity-60" : ""}`}
    >
      <span
        className={`inline-flex h-6 shrink-0 items-center rounded-control px-2 font-mono text-label font-semibold tabular-nums ${CHIP_STYLES[state]} transition-colors duration-200`}
        suppressHydrationWarning
      >
        {chipLabel(scenario, state, now)}
      </span>
      {headline && (
        <span className={`text-small max-md:hidden ${HEADLINE_STYLES[state] ?? "text-muted"}`}>{headline}</span>
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
        {Object.keys(SCENARIO_TITLES).map((id) => {
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
                  <Cell key={mode} scenario={scenarioOf(mode)} now={now} dimmed={previous[mode]} />
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
              {MODE_LABELS[mode].name} cost in this run: <b className="font-semibold text-fail">{harms.join(" · ")}</b>
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
