"use client";

import { useId, useState } from "react";
import { ClaudeAnalysis } from "./analysis-panel";
import { HandlingCode } from "./handling-code";
import { MODE_LABELS, type Mode, type ScenarioView, type StoreCode } from "./report";
import { ScenarioCard } from "./scenario-card";
import { ScenarioTrace } from "./scenario-trace";

/** Where each card sits on a wide screen: side by side, everything else as wide as both below. */
const CARD_PLACE: Record<Mode, string> = {
  naive: "lg:col-start-1 lg:row-start-1",
  hardened: "lg:col-start-2 lg:row-start-1",
};

/** The DOM id of a scenario's section, which the matrix scrolls to. */
export function sectionId(id: string): string {
  return `scenario-${id}`;
}

/** The DOM id of one store's analysis of a scenario, which "Claude's full analysis" scrolls to. */
export function analysisId(id: string, mode: Mode): string {
  return `analysis-${id}-${mode}`;
}

/**
 * One scenario across the given stores, two levels deep at most: a panel per piece, and inside a
 * panel only code, a patch or the trace grid. On a wide screen the stores' cards sit side by side;
 * below them, as wide as both, Claude's analysis of a store that failed, the code of a store that
 * passed, and each open trace. On a narrow screen each store's pieces follow its card.
 */
export function ScenarioSection({
  id,
  modes,
  scenarios,
  now,
  deadlineMs,
  code,
  dimmed,
}: {
  id: string;
  modes: Mode[];
  scenarios: Record<Mode, ScenarioView | null>;
  now: number;
  deadlineMs: Record<Mode, number>;
  code: StoreCode;
  dimmed: Record<Mode, boolean>;
}) {
  const [traces, setTraces] = useState<Record<Mode, boolean>>({ naive: false, hardened: false });
  const [highlight, setHighlight] = useState<Record<Mode, number | null>>({ naive: null, hardened: null });
  const prefix = useId();
  const side = modes.length > 1;
  const wide = side ? "lg:col-span-2" : "";

  function toggleTrace(mode: Mode) {
    setTraces((current) => ({ ...current, [mode]: !current[mode] }));
  }

  function showStep(mode: Mode, seq: number) {
    setTraces((current) => ({ ...current, [mode]: true }));
    setHighlight((current) => ({ ...current, [mode]: seq }));
  }

  return (
    <section
      id={sectionId(id)}
      aria-label={id}
      className={`grid scroll-mt-6 gap-3 ${side ? "lg:grid-cols-2" : ""}`}
    >
      {modes.map((mode) => {
        const traceId = `${prefix}-${mode}-trace`;
        const scenario = scenarios[mode];
        const failed = scenario?.verdict === "FAIL" || scenario?.verdict === "INCONCLUSIVE";
        const passed = scenario?.verdict === "PASS";
        const steps = scenario?.steps ?? [];
        return [
          <div key={`${mode}-card`} className={`min-w-0 ${side ? CARD_PLACE[mode] : ""}`}>
            <ScenarioCard
              id={id}
              mode={mode}
              scenario={scenario}
              now={now}
              deadlineMs={deadlineMs[mode]}
              traceOpen={traces[mode]}
              traceId={traceId}
              onToggleTrace={() => toggleTrace(mode)}
              dimmed={dimmed[mode]}
            />
          </div>,
          failed && scenario ? (
            <div key={`${mode}-analysis`} className={`min-w-0 ${wide}`}>
              <ClaudeAnalysis scenario={scenario} store={MODE_LABELS[mode].name} id={analysisId(id, mode)} onStep={(seq) => showStep(mode, seq)} />
            </div>
          ) : null,
          passed && code.snippets[mode]?.[id] ? (
            <div key={`${mode}-code`} className={`min-w-0 ${wide}`}>
              <HandlingCode id={id} mode={mode} code={code} />
            </div>
          ) : null,
          traces[mode] && steps.length > 0 ? (
            <div key={`${mode}-trace`} className={`min-w-0 ${wide}`}>
              <ScenarioTrace
                id={id}
                mode={mode}
                steps={steps}
                highlightSeq={highlight[mode]}
                domId={traceId}
                onClose={() => toggleTrace(mode)}
              />
            </div>
          ) : null,
        ];
      })}
    </section>
  );
}
