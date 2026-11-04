import { describe, expect, it } from "vitest";
import { summarize } from "./views";

describe("summarize", () => {
  it("counts INCONCLUSIVE apart from passes and failures", () => {
    const summary = summarize([
      { status: "COMPLETED", verdict: "PASS" },
      { status: "COMPLETED", verdict: "FAIL" },
      { status: "COMPLETED", verdict: "INCONCLUSIVE" },
      { status: "COMPLETED", verdict: "INCONCLUSIVE" },
      { status: "ERROR", verdict: null },
      { status: "WAITING_FOR_WEBHOOK", verdict: null },
    ]);
    expect(summary).toEqual({ total: 6, passed: 1, failed: 1, inconclusive: 2, errors: 1 });
  });
});

describe("runView", () => {
  it("shows a scenario left running by a finished run as an error", async () => {
    const { runView } = await import("./views");
    const now = new Date();
    const run = {
      id: "3f1c2b9e-8d4a-4c1e-9f2b-6a7d8e9f0a1b",
      mode: "hardened" as const,
      status: "COMPLETED" as const,
      scenarioIds: ["S4"],
      storeTimeoutMs: 8000,
      proxyHoldMs: 10_000,
      freshAnalysis: false,
      error: null,
      createdAt: now,
      startedAt: now,
      finishedAt: now,
    };
    const scenario = {
      runId: run.id,
      scenarioId: "S4",
      cartId: "cart-1",
      runKey: "k",
      status: "RUNNING" as const,
      verdict: null,
      reason: null,
      headline: null,
      harm: null,
      error: null,
      lastSeq: 6,
      captureAttempts: 1,
      startedAt: now,
      finishedAt: null,
      waitingSince: null,
      analysisKey: null,
      analysisReused: null,
    };
    const view = runView(run, [scenario]);
    expect(view.scenarios[0]).toMatchObject({ status: "ERROR", error: "The run ended before this scenario recorded its result." });
    expect(view.summary.errors).toBe(1);
    expect(view.consequences).toEqual([]);
  });
});
