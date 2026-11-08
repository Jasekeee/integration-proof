// What a CLI run leaves behind: a line per scenario on the console, report.json with every step,
// and a Markdown summary for a CI job page. Expectations (--expect) decide the exit code.
import { CONTRACT_SCENARIOS, CONTRACT_VERSION, type ContractScenarioId } from "./contract";
import type { CliVerdict, ScenarioResult } from "./run";

export type Expectations = Partial<Record<ContractScenarioId, CliVerdict>>;

const VERDICTS: CliVerdict[] = ["PASS", "FAIL", "INCONCLUSIVE", "ERROR"];

/** "S1=PASS,S2=FAIL" into expectations; throws on anything else. */
export function parseExpectations(value: string | undefined): Expectations {
  const expected: Expectations = {};
  if (!value) return expected;
  for (const pair of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [id, verdict] = pair.split("=").map((part) => part.trim().toUpperCase());
    if (!(CONTRACT_SCENARIOS as readonly string[]).includes(id) || !VERDICTS.includes(verdict as CliVerdict)) {
      throw new Error(`--expect takes S1..S3=PASS|FAIL|INCONCLUSIVE|ERROR, comma-separated; got "${pair}".`);
    }
    expected[id as ContractScenarioId] = verdict as CliVerdict;
  }
  return expected;
}

export interface Report {
  contract: number;
  store: string;
  paypal: "sandbox" | "model";
  holdMs: number;
  startedAt: string;
  durationMs: number;
  /** True when every verdict matched its expectation, or, without expectations, every scenario passed. */
  ok: boolean;
  expected: Expectations;
  scenarios: ScenarioResult[];
}

export function buildReport(input: Omit<Report, "contract" | "ok">): Report {
  const ok = input.scenarios.every((scenario) => {
    const expected = input.expected[scenario.id];
    return expected ? scenario.verdict === expected : scenario.verdict === "PASS";
  });
  return { contract: CONTRACT_VERSION, ...input, ok };
}

function expectation(report: Report, scenario: ScenarioResult): string {
  const expected = report.expected[scenario.id];
  if (!expected) return "";
  return scenario.verdict === expected ? `as expected` : `expected ${expected}`;
}

export function consoleLines(report: Report): string[] {
  const lines = report.scenarios.map((scenario) => {
    const note = expectation(report, scenario);
    return `${scenario.id}  ${scenario.verdict.padEnd(12)} ${scenario.headline}${note ? `  (${note})` : ""}\n    ${scenario.reason}`;
  });
  lines.push(report.ok ? "Result: every scenario as expected." : "Result: not as expected.");
  return lines;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function markdown(report: Report): string {
  const expectations = Object.keys(report.expected).length > 0;
  const rows = report.scenarios.map((scenario) => {
    const base = `| ${scenario.id} · ${cell(scenario.title)} | **${scenario.verdict}** | ${cell(scenario.headline)} | ${cell(scenario.reason)} |`;
    return expectations ? `${base} ${cell(expectation(report, scenario) || "—")} |` : base;
  });
  return [
    `### Integration Proof · store contract v${report.contract}`,
    "",
    `Store \`${report.store}\` · PayPal: ${report.paypal === "model" ? "offline model of the sandbox" : "sandbox"} · ${(report.durationMs / 1000).toFixed(1)} s`,
    "",
    `| Scenario | Verdict | What happened | Why |${expectations ? " Expected |" : ""}`,
    `|---|---|---|---|${expectations ? "---|" : ""}`,
    ...rows,
    "",
    report.ok ? "Every scenario as expected." : "**Not as expected.** The full trace of every scenario is in report.json.",
    "",
  ].join("\n");
}
