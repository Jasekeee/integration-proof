"use client";

import { useId, useState } from "react";
import type { Mode, ScenarioView, StoreCode } from "./report";
import { ScenarioCard } from "./scenario-card";
import { ScenarioTrace } from "./scenario-trace";

/** Where each piece sits on a wide screen: the cards side by side, each open trace below both. */
const CARD_PLACE: Record<Mode, string> = {
  naive: "lg:col-start-1 lg:row-start-1",
  hardened: "lg:col-start-2 lg:row-start-1",
};

/** The DOM id of a scenario's section, which the matrix scrolls to. */
export function sectionId(id: string): string {
  return `scenario-${id}`;
}

/**
 * One scenario across the given stores. On a wide screen the stores' cards sit side by side and an
 * open trace spans both columns below them; on a narrow one each trace follows its own card.
 */
export function ScenarioSection({
  id,
  modes,
  scenarios,
  now,
  deadlineMs,
  code,
  expanded,
  onToggle,
  dimmed,
  analysisOpen = false,
}: {
  id: string;
  modes: Mode[];
  scenarios: Record<Mode, ScenarioView | null>;
  now: number;
  deadlineMs: Record<Mode, number>;
  code: StoreCode;
  expanded: Record<Mode, boolean>;
  onToggle: (mode: Mode) => void;
  dimmed: Record<Mode, boolean>;
  /** Claude's analyses open with their evidence and fix showing. */
  analysisOpen?: boolean;
}) {
  const [traces, setTraces] = useState<Record<Mode, boolean>>({ naive: false, hardened: false });
  const [highlight, setHighlight] = useState<Record<Mode, number | null>>({ naive: null, hardened: null });
  const prefix = useId();
  const side = modes.length > 1;

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
      className={`grid scroll-mt-6 gap-4 ${side ? "lg:grid-cols-2 lg:items-start lg:gap-x-6" : ""}`}
    >
      {modes.map((mode) => {
        const traceId = `${prefix}-${mode}-trace`;
        const steps = scenarios[mode]?.steps ?? [];
        return [
          <div key={`${mode}-card`} className={`flex min-w-0 flex-col ${side ? CARD_PLACE[mode] : ""}`}>
            <ScenarioCard
              id={id}
              mode={mode}
              scenario={scenarios[mode]}
              now={now}
              deadlineMs={deadlineMs[mode]}
              code={code}
              expanded={expanded[mode]}
              onToggle={() => onToggle(mode)}
              traceOpen={traces[mode]}
              traceId={traceId}
              onToggleTrace={() => toggleTrace(mode)}
              onStep={(seq) => showStep(mode, seq)}
              dimmed={dimmed[mode]}
              analysisOpen={analysisOpen}
            />
          </div>,
          traces[mode] && steps.length > 0 ? (
            <div key={`${mode}-trace`} className={`min-w-0 ${side ? "lg:col-span-2" : ""}`}>
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
