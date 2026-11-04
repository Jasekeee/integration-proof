// The bench must reproduce the live sandbox before it can judge a fix: the naive store passes S1
// only, with the same headlines a live run shows, and the hardened store passes all six.
import { describe, expect, it } from "vitest";
import { runOnBench } from "./harness";

const ALL = ["S1", "S2", "S3", "S4", "S5", "S6"];

describe("offline bench", () => {
  it("gives the naive store the verdicts and headlines of the live sandbox: 1/6", async () => {
    const run = await runOnBench({ mode: "naive", scenarioIds: ALL });
    expect(run.violations).toEqual([]);
    expect(run.refused).toEqual([]);
    expect(run.scenarios.map(({ id, verdict, headline }) => [id, verdict, headline])).toEqual([
      ["S1", "PASS", "Decline shown, nothing charged"],
      ["S2", "FAIL", "Sale lost on a transient error"],
      ["S3", "FAIL", "Buyer charged twice"],
      ["S4", "FAIL", "Order shipped twice"],
      ["S5", "FAIL", "Refunded order shown as paid"],
      ["S6", "FAIL", "Forged refund accepted"],
    ]);
  }, 60_000);

  it("gives the hardened store 6/6", async () => {
    const run = await runOnBench({ mode: "hardened", scenarioIds: ALL });
    expect(run.violations).toEqual([]);
    expect(run.refused).toEqual([]);
    expect(run.scenarios.map(({ id, verdict }) => [id, verdict])).toEqual(ALL.map((id) => [id, "PASS"]));
  }, 60_000);
});
