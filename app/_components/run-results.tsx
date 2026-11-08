"use client";

import Link from "next/link";
import { useNow, useRunReport } from "./hooks";
import { Icon } from "./icon";
import { ScenarioRows } from "./proof-scenes";
import { isRunActive, SCENARIO_TITLES, seconds, type Mode, type RunReport, type StoreCode } from "./report";
import { Tally } from "./tally";
import { linkProse } from "./ui";

const SCENARIO_IDS = Object.keys(SCENARIO_TITLES);

/** What the run cost, in the server's own words, or that every failure was handled. */
function Consequences({ report }: { report: RunReport }) {
  if (isRunActive(report)) return null;
  if (report.consequences.length > 0) {
    return <p className="text-lg text-pretty text-fail">This run: {report.consequences.join(" · ")}</p>;
  }
  if (report.status === "COMPLETED" && report.summary.passed === report.summary.total) {
    return <p className="text-lg text-pretty text-pass">This run: all {report.summary.total} failures handled, nothing charged or shipped twice</p>;
  }
  return null;
}

/**
 * One run's results at a permanent address, in the proof page's two layers: the score and what
 * came of each scenario first, the technical details behind each scene. It keeps following the run
 * while it is in progress.
 */
export function RunResults({ initial, code }: { initial: RunReport; code: StoreCode }) {
  const report = useRunReport(initial.id, initial) ?? initial;
  const now = useNow(isRunActive(report));
  const mode = report.mode;
  const other: Mode = mode === "naive" ? "hardened" : "naive";
  const scenarios = { naive: null, hardened: null };
  const deadline = report.config.webhookDeadlineMs;

  return (
    <div className="flex flex-col">
      <header className="flex flex-col items-center gap-6 pb-10 pt-12 text-center sm:pb-12 sm:pt-16">
        <h1 className="text-lg text-muted">One proof run</h1>
        <Tally mode={mode} report={report} now={now} previous={false} />
        <Consequences report={report} />
        <Link href="/proof" className={`group inline-flex items-center gap-1 ${linkProse}`}>
          Compare with the {other} store
          <Icon name="arrow-right" className="size-4 transition-transform duration-150 ease-(--ease-out) group-hover:translate-x-0.5" />
        </Link>
      </header>

      <ScenarioRows
        ids={SCENARIO_IDS}
        modes={[mode]}
        scenariosOf={(id) => ({ ...scenarios, [mode]: report.scenarios.find((scenario) => scenario.id === id) ?? null })}
        now={now}
        deadlineMs={{ naive: deadline, hardened: deadline }}
        code={code}
        dimmed={{ naive: false, hardened: false }}
      />

      <p className="pt-6 font-mono text-xs tabular-nums text-muted" suppressHydrationWarning>
        Run {report.id.slice(0, 8)} · {new Date(report.createdAt).toUTCString()}
        {report.status === "COMPLETED" && report.durationMs !== null && ` · ${seconds(report.durationMs)}`}
        {report.status === "ERROR" && ` · stopped: ${report.error ?? "unknown error"}`}
        {report.status === "COMPLETED" && report.error && ` · ${report.error}`}
      </p>
    </div>
  );
}
