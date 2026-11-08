// What a CLI run leaves behind: a line per scenario on the console, report.json with every step,
// and a Markdown summary for a CI job page. Expectations (--expect) decide the exit code.
import { plainHeadline } from "../lib/proof/headlines";
import { CONTRACT_SCENARIOS, CONTRACT_VERSION, type ContractScenarioId } from "./contract";
import type { Explanation } from "./explain";
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
  /** With --explain: Claude's analysis of each failure, and the model that wrote it. */
  explanations?: { model: string; items: Explanation[] };
}

export function buildReport(input: Omit<Report, "contract" | "ok" | "explanations">): Report {
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

/**
 * The verdicts counted, for a run without --expect: "1 passed, 2 failed, 0 inconclusive." Errors
 * are named only when there is one.
 */
export function tally(report: Report): string {
  const count = (verdict: CliVerdict) => report.scenarios.filter((scenario) => scenario.verdict === verdict).length;
  const errors = count("ERROR");
  return `${count("PASS")} passed, ${count("FAIL")} failed, ${count("INCONCLUSIVE")} inconclusive${errors > 0 ? `, ${errors} could not run` : ""}.`;
}

const hasExpectations = (report: Report) => Object.keys(report.expected).length > 0;

export function consoleLines(report: Report): string[] {
  const lines = report.scenarios.map((scenario) => {
    const note = expectation(report, scenario);
    return `${scenario.id}  ${scenario.verdict.padEnd(12)} ${plainHeadline(scenario.headline)}${note ? `  (${note})` : ""}\n    ${scenario.reason}`;
  });
  // With --expect the result is measured against it; without, it is only counted.
  if (!hasExpectations(report)) lines.push(`Result: ${tally(report)}`);
  else lines.push(report.ok ? "Result: every scenario as expected." : "Result: not as expected.");
  return lines;
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function markdown(report: Report): string {
  const expectations = hasExpectations(report);
  const rows = report.scenarios.map((scenario) => {
    const base = `| ${scenario.id} · ${cell(scenario.title)} | **${scenario.verdict}** | ${cell(plainHeadline(scenario.headline))} | ${cell(scenario.reason)} |`;
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
    expectations
      ? report.ok
        ? "Every scenario as expected."
        : "**Not as expected.** The full trace of every scenario is in report.json."
      : `${tally(report)}${report.ok ? "" : " The full trace of every scenario is in report.json."}`,
    "",
  ].join("\n");
}

/** Claude's analysis in a few lines per failure, for the console. */
export function explanationLines(report: Report): string[] {
  if (!report.explanations) return [];
  const lines = [`Claude's analysis (${report.explanations.model}). Verdicts are decided by code; nothing below was applied or run.`];
  for (const item of report.explanations.items) {
    if (item.result.status !== "READY") {
      lines.push(`${item.id}  unavailable: ${item.result.reason}`);
      continue;
    }
    const { analysis } = item.result;
    lines.push(`${item.id}  ${analysis.rootCause}`);
    lines.push(`    Fix: ${analysis.fix.summary}`);
    lines.push(`    Evidence: ${analysis.evidence.map((evidence) => `step ${evidence.stepId}`).join(", ")} · confidence ${analysis.confidence}`);
    lines.push(`    Patch: ${item.patch ? "checked against the file, applies exactly" : (item.note ?? "none")}`);
  }
  return lines;
}

/** Claude's analysis as Markdown, after the verdict table. */
export function explanationMarkdown(report: Report): string {
  if (!report.explanations) return "";
  const out = [
    `### Claude's analysis`,
    "",
    `By ${report.explanations.model}. The verdicts above are decided by code, not by the model. The CLI never applied or ran the code below: review the patch before you apply it.`,
    "",
  ];
  for (const item of report.explanations.items) {
    const scenario = report.scenarios.find((candidate) => candidate.id === item.id);
    out.push(`#### ${item.id} · ${scenario?.title ?? ""}`, "");
    if (item.result.status !== "READY") {
      out.push(`Analysis unavailable: ${item.result.reason}`, "");
      continue;
    }
    const { analysis } = item.result;
    out.push(
      `**Root cause.** ${analysis.rootCause}`,
      "",
      `**What it costs.** ${analysis.businessImpact}`,
      "",
      "**Evidence in the trace.**",
      "",
      ...analysis.evidence.map((evidence) => `- Step ${evidence.stepId}: ${evidence.observation}`),
      "",
      `**Fix.** ${analysis.fix.summary}`,
      "",
    );
    if (item.patch) out.push("```diff", item.patch.trimEnd(), "```", "");
    else out.push(`No patch: ${item.note ?? "none proposed"}`, "");
    out.push(`**Verify by.** ${analysis.verifyBy}`, "");
  }
  return out.join("\n");
}
