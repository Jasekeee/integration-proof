"use client";

import { useNow, useRunReport } from "./hooks";
import { isRunActive, SCENARIO_TITLES, type RunReport, type StoreCode } from "./report";
import { RunHeader } from "./run-header";
import { ScenarioCard } from "./scenario-card";

/** One run's results at a permanent address. It keeps following the run while it is in progress. */
export function RunResults({ initial, code }: { initial: RunReport; code: StoreCode }) {
  const report = useRunReport(initial.id, initial) ?? initial;
  const now = useNow(isRunActive(report));

  return (
    <div className="flex flex-col gap-4">
      <RunHeader mode={report.mode} report={report} now={now} />
      {/* One column: this is the detailed view, and each trace gets the full width. */}
      <div className="flex flex-col gap-4">
        {Object.keys(SCENARIO_TITLES).map((id) => (
          <ScenarioCard
            key={id}
            id={id}
            mode={report.mode}
            code={code}
            scenario={report.scenarios.find((scenario) => scenario.id === id) ?? null}
            now={now}
            deadlineMs={report.config.webhookDeadlineMs}
          />
        ))}
      </div>
    </div>
  );
}
