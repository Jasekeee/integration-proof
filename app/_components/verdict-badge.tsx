import type { ScenarioView } from "./report";

const STYLES = {
  PASS: "bg-pass-bg text-pass",
  FAIL: "bg-fail-bg text-fail",
  INCONCLUSIVE: "bg-warn-bg text-warn",
  pending: "bg-surface-2 text-muted",
} as const;

/** PASS green, FAIL red, INCONCLUSIVE amber; the word carries the meaning, not the color alone. */
export function VerdictBadge({ scenario }: { scenario: Pick<ScenarioView, "verdict" | "status"> | null }) {
  const label = scenario?.verdict ?? (scenario?.status === "ERROR" ? "ERROR" : scenario ? "RUNNING" : "NOT RUN");
  const style = scenario?.verdict ? STYLES[scenario.verdict] : STYLES.pending;
  return (
    <span
      className={`inline-flex h-6 shrink-0 items-center rounded-control px-2 text-xs font-semibold tracking-wide ${style}`}
    >
      {label}
    </span>
  );
}
