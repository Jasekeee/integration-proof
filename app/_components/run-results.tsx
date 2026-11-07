"use client";

import { useState } from "react";
import { useNow, useRunReport } from "./hooks";
import { FLAGSHIP_SCENARIO, isRunActive, SCENARIO_TITLES, type RunReport, type StoreCode } from "./report";
import { RunHeader } from "./run-header";
import { ScenarioSection } from "./scenario-section";

const NONE = { naive: false, hardened: false };

/** One run's results at a permanent address. It keeps following the run while it is in progress. */
export function RunResults({ initial, code }: { initial: RunReport; code: StoreCode }) {
  const report = useRunReport(initial.id, initial) ?? initial;
  const now = useNow(isRunActive(report));
  const mode = report.mode;
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({ [FLAGSHIP_SCENARIO]: true });

  return (
    <div className="flex flex-col gap-4">
      <RunHeader mode={mode} report={report} now={now} />
      {/* One column: this is the detailed view, and each trace gets the full width. */}
      <div className="flex flex-col gap-4">
        {Object.keys(SCENARIO_TITLES).map((id) => (
          <ScenarioSection
            key={id}
            id={id}
            modes={[mode]}
            scenarios={{ naive: null, hardened: null, [mode]: report.scenarios.find((scenario) => scenario.id === id) ?? null }}
            now={now}
            deadlineMs={{ naive: report.config.webhookDeadlineMs, hardened: report.config.webhookDeadlineMs }}
            code={code}
            expanded={{ ...NONE, [mode]: unfolded[id] ?? false }}
            onToggle={() => setUnfolded((current) => ({ ...current, [id]: !current[id] }))}
            dimmed={NONE}
          />
        ))}
      </div>
    </div>
  );
}
