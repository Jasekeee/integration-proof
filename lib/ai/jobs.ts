// Runs the analysis of one scenario after its verdict, writes every model call to the scenario's
// trace, and reuses a cached analysis when the scenario failed the same way before.
import Anthropic from "@anthropic-ai/sdk";
import type { TraceStepRow } from "../db/schema";
import { nextSeq, readRun, readTrace, writeStep } from "../proof/repository";
import { SCENARIOS, ScenarioIdSchema } from "../proof/scenarios";
import { analyzeOnce, type AnalysisCache, type AnalystClient, type ModelCall } from "./analyst";
import { databaseCache, linkAnalysis } from "./repository";
import { analysisKey, traceSignature } from "./signature";
import { readStoreSources } from "./sources";

/** Generous: a high-effort answer with a patch can take a minute or two. The SDK retries 429 and 5xx. */
const REQUEST_TIMEOUT_MS = 300_000;

const ANTHROPIC_MESSAGES_PATH = "/v1/messages";

function createClient(): AnalystClient {
  return new Anthropic({ timeout: REQUEST_TIMEOUT_MS, maxRetries: 2 });
}

/** Analyses a FAIL or INCONCLUSIVE scenario of a run. Never throws; failures end in the trace. */
export async function analyzeScenario(runId: string, scenarioId: string, client: () => AnalystClient = createClient) {
  let claimed: { key: string; cache: AnalysisCache } | null = null;
  try {
    const found = await readRun(runId);
    const row = found?.scenarios.find((scenario) => scenario.scenarioId === scenarioId);
    if (!found || !row || (row.verdict !== "FAIL" && row.verdict !== "INCONCLUSIVE")) return;
    const model = process.env.ANTHROPIC_MODEL;
    if (!model) {
      await recordNote(runId, scenarioId, "No analysis: ANTHROPIC_MODEL is not set.");
      return;
    }

    const scenario = SCENARIOS[ScenarioIdSchema.parse(scenarioId)];
    const steps = (await readTrace(runId, scenarioId)).filter((step) => step.actor !== "analyst");
    const sources = await readStoreSources(found.run.mode);
    const reason = row.reason ?? "";
    const key = analysisKey({
      scenarioId,
      model,
      codeHash: sources.hash,
      traceSignature: traceSignature(steps, row.verdict, reason),
    });

    const input = {
      scenario: {
        id: scenario.id,
        title: scenario.title,
        summary: scenario.summary,
        passWhen: scenario.passWhen,
        storeFunction: scenario.storeFunction,
      },
      mode: found.run.mode,
      verdict: row.verdict,
      reason,
      steps: steps.map(toAnalystStep),
      sources,
    };

    const stored = databaseCache({ scenarioId, mode: found.run.mode, model });
    // Every model call is in the trace before the analysis reads as finished.
    const cache: AnalysisCache = {
      claim: stored.claim,
      save: async (analysisKeyToSave, result) => {
        for (const call of result.calls) await recordCall(runId, scenarioId, call);
        await stored.save(analysisKeyToSave, result);
      },
    };
    const outcome = await analyzeOnce(key, input, {
      client: client(),
      model,
      cache,
      fresh: found.run.freshAnalysis,
      // The row exists once claimed; linking it before the call makes the page show "Analyzing…".
      onClaim: async (claim) => {
        if (claim === "claimed") claimed = { key, cache };
        await linkAnalysis(runId, scenarioId, key, claim !== "claimed");
      },
    });
    if (outcome.reused) {
      await recordNote(
        runId,
        scenarioId,
        outcome.claim === "ready"
          ? "Reused the analysis of an earlier run that failed the same way with the same store code; no model call."
          : "The same failure is already being analysed; this scenario shows that analysis when it is ready.",
      );
      return;
    }
  } catch (error) {
    console.error(`Analysis of ${scenarioId} in run ${runId} failed`, error);
    const reason = `The analysis stopped: ${error instanceof Error ? error.message : String(error)}`;
    // A claimed row must not stay PENDING, or the page would show "Analyzing…" until it goes stale.
    const owned = claimed as { key: string; cache: AnalysisCache } | null;
    if (owned) await owned.cache.save(owned.key, { status: "UNAVAILABLE", reason, calls: [] }).catch(() => undefined);
    await recordNote(runId, scenarioId, reason).catch(() => undefined);
  }
}

function toAnalystStep(step: TraceStepRow) {
  return {
    seq: step.seq,
    actor: step.actor,
    method: step.method,
    path: step.path,
    httpStatus: step.httpStatus,
    debugId: step.debugId,
    paypalRequestId: step.paypalRequestId,
    fault: step.fault,
    note: step.note,
    requestBody: step.requestBody,
    responseBody: step.responseBody,
  };
}

/** Rule 6: every model call is a trace step, with the model, tokens, duration and outcome. */
async function recordCall(runId: string, scenarioId: string, call: ModelCall): Promise<void> {
  const usage = call.usage
    ? `${call.usage.input + call.usage.cacheRead + call.usage.cacheWrite} input tokens ` +
      `(${call.usage.cacheRead} read from cache, ${call.usage.cacheWrite} written to cache), ${call.usage.output} output tokens`
    : "no response";
  const problems = call.problems.length > 0 ? ` ${call.problems.join(" ")}` : "";
  await writeStep(runId, scenarioId, await nextSeq(runId, scenarioId), {
    actor: "analyst",
    startedAt: call.startedAt,
    durationMs: call.durationMs,
    method: "POST",
    path: ANTHROPIC_MESSAGES_PATH,
    httpStatus: call.httpStatus,
    note: `Attempt ${call.attempt}, ${call.model}: ${call.outcome}; ${usage}.${problems}`,
    responseBody: {
      model: call.model,
      outcome: call.outcome,
      stopReason: call.stopReason,
      usage: call.usage,
      problems: call.problems,
    },
  });
}

async function recordNote(runId: string, scenarioId: string, note: string): Promise<void> {
  await writeStep(runId, scenarioId, await nextSeq(runId, scenarioId), {
    actor: "analyst",
    startedAt: new Date(),
    durationMs: 0,
    note,
  });
}
