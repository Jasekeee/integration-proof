// JSON shapes the runs API returns. The scenarios' run keys are never part of them.
import type { RunRow, RunScenarioRow, ScenarioStatus, TraceStepRow } from "../db/schema";
import { SCENARIOS, ScenarioIdSchema } from "./scenarios";

export const SCENARIO_STATUS_LABELS: Record<ScenarioStatus, string> = {
  QUEUED: "queued",
  RUNNING: "running",
  WAITING_FOR_WEBHOOK: "waiting for PayPal webhook",
  COMPLETED: "completed",
  ERROR: "error",
};

function durationMs(startedAt: Date | null, finishedAt: Date | null): number | null {
  if (!startedAt) return null;
  return (finishedAt ?? new Date()).getTime() - startedAt.getTime();
}

export function runView(run: RunRow, scenarios: RunScenarioRow[]) {
  const count = (verdict: "PASS" | "FAIL") => scenarios.filter((row) => row.verdict === verdict).length;
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    error: run.error,
    summary: {
      total: scenarios.length,
      passed: count("PASS"),
      failed: count("FAIL"),
      errors: scenarios.filter((row) => row.status === "ERROR").length,
    },
    config: { storeTimeoutMs: run.storeTimeoutMs, proxyHoldMs: run.proxyHoldMs },
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: durationMs(run.startedAt, run.finishedAt),
    scenarios: scenarios.map((row) => {
      const id = ScenarioIdSchema.safeParse(row.scenarioId);
      return {
        id: row.scenarioId,
        title: id.success ? SCENARIOS[id.data].title : row.scenarioId,
        status: row.status,
        statusLabel: SCENARIO_STATUS_LABELS[row.status],
        verdict: row.verdict,
        reason: row.reason,
        error: row.error,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: durationMs(row.startedAt, row.finishedAt),
      };
    }),
  };
}

export function stepView(step: TraceStepRow) {
  return {
    id: step.id,
    seq: step.seq,
    actor: step.actor,
    startedAt: step.startedAt,
    durationMs: step.durationMs,
    method: step.method,
    path: step.path,
    httpStatus: step.httpStatus,
    debugId: step.debugId,
    paypalRequestId: step.paypalRequestId,
    fault: step.fault,
    requestBody: step.requestBody,
    responseBody: step.responseBody,
    note: step.note,
  };
}
