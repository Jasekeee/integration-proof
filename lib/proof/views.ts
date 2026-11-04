// JSON shapes the runs API returns. The scenarios' run keys are never part of them.
import { AnalysisSchema } from "../ai/analyst";
import type { AnalysisRow, RunRow, RunScenarioRow, ScenarioStatus, TraceStepRow, Verdict } from "../db/schema";
import { WEBHOOK_DEADLINE_MS } from "./runner";
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

/** Counts per outcome. INCONCLUSIVE is its own count: it is neither a pass nor a failure. */
export function summarize(scenarios: Pick<RunScenarioRow, "status" | "verdict">[]) {
  const count = (verdict: Verdict) => scenarios.filter((row) => row.verdict === verdict).length;
  return {
    total: scenarios.length,
    passed: count("PASS"),
    failed: count("FAIL"),
    inconclusive: count("INCONCLUSIVE"),
    errors: scenarios.filter((row) => row.status === "ERROR").length,
  };
}

/** The stored analysis, read back through the schema: rows are data and are checked like any input. */
export function analysisView(row: AnalysisRow | undefined, reused: boolean | null) {
  if (!row) return null;
  return {
    status: row.status,
    reused: reused ?? false,
    model: row.model,
    durationMs: row.durationMs,
    attempts: row.attempts,
    tokens: {
      input: row.inputTokens,
      output: row.outputTokens,
      cacheRead: row.cacheReadTokens,
      cacheWrite: row.cacheWriteTokens,
    },
    result: row.status === "READY" ? (AnalysisSchema.safeParse(row.result).data ?? null) : null,
    patchStatus: row.patchStatus,
    patchNote: row.patchNote,
    error: row.error,
    completedAt: row.completedAt,
  };
}

export function runView(run: RunRow, stored: RunScenarioRow[], analyses: AnalysisRow[] = []) {
  const byKey = new Map(analyses.map((row) => [row.key, row]));
  // Rows left unfinished by a run that is over read as what they are: never finished.
  const runOver = run.status === "COMPLETED" || run.status === "ERROR";
  const scenarios = stored.map((row) =>
    runOver && row.status !== "COMPLETED" && row.status !== "ERROR"
      ? { ...row, status: "ERROR" as const, error: row.error ?? "The run ended before this scenario recorded its result." }
      : row,
  );
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    error: run.error,
    summary: summarize(scenarios),
    config: {
      storeTimeoutMs: run.storeTimeoutMs,
      proxyHoldMs: run.proxyHoldMs,
      webhookDeadlineMs: WEBHOOK_DEADLINE_MS,
      freshAnalysis: run.freshAnalysis,
    },
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: durationMs(run.startedAt, run.finishedAt),
    scenarios: scenarios.map((row) => {
      const id = ScenarioIdSchema.safeParse(row.scenarioId);
      return {
        id: row.scenarioId,
        title: id.success ? SCENARIOS[id.data].title : row.scenarioId,
        passWhen: id.success ? SCENARIOS[id.data].passWhen : null,
        status: row.status,
        statusLabel: SCENARIO_STATUS_LABELS[row.status],
        waitingSince: row.waitingSince,
        verdict: row.verdict,
        reason: row.reason,
        headline: row.headline,
        error: row.error,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: durationMs(row.startedAt, row.finishedAt),
        analysis: row.analysisKey ? analysisView(byKey.get(row.analysisKey), row.analysisReused) : null,
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
