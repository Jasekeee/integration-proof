/**
 * Saves Claude's fixes for S2 to S6 into fixtures/ai-fixes/, where scripts/verify-ai-fixes.ts checks
 * them offline. Only committed patches are ever verified; model-generated code never runs on the
 * server.
 *
 *   npx tsx scripts/export-ai-fixes.ts                          from the database in .env.local
 *   npx tsx scripts/export-ai-fixes.ts --url https://integration-proof.onrender.com
 *   npx tsx scripts/export-ai-fixes.ts --run <runId>            one run instead of the newest
 *
 * A fix is exported only when its analysis was written for the store code in this checkout: the
 * analysis cache key, a hash of the scenario, the model, the store code and the trace, is computed
 * again from the current files and the run's trace, and must equal the stored key. An analysis of
 * older code would be verified against a file it never saw. The newest completed naive run whose
 * five failures all pass that test is taken.
 *
 * Writes S2.patch ... S6.patch exactly as the model wrote them, and meta.json with the model, the
 * date, the run id and the confidence of each. Nothing else from the run is saved.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ANALYSIS_FORMAT, analysisKey, traceSignature, type SignatureStep } from "../lib/ai/signature";
import { readStoreSources } from "../lib/ai/sources";

const SCENARIOS = ["S2", "S3", "S4", "S5", "S6"] as const;
const OUT_DIR = "fixtures/ai-fixes";
const TARGET = "lib/store/naive.ts";

/** Nothing that looks like a credential may reach a committed fixture. */
const SECRET_PATTERNS = [/sk-ant-[A-Za-z0-9_-]{10,}/, /A21AA[A-Za-z0-9_-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];

const ResultSchema = z.object({
  confidence: z.enum(["low", "medium", "high"]),
  fix: z.object({
    summary: z.string(),
    patch: z.string(),
    selfCheck: z.object({ checks: z.number(), matched: z.boolean() }).optional(),
  }),
});

/** One failed scenario with its analysis, from either source. */
interface Candidate {
  id: string;
  verdict: string | null;
  reason: string | null;
  headline: string | null;
  steps: SignatureStep[];
  analysis: {
    key: string | null;
    status: string;
    model: string;
    completedAt: string | null;
    patchStatus: string | null;
    patchNote: string | null;
    result: unknown;
  } | null;
}

interface RunCandidate {
  id: string;
  finishedAt: string | null;
  link: string;
  scenarios: Candidate[];
}

/** Why a run cannot be exported, or null when all five fixes can. */
function rejection(run: RunCandidate, codeHash: string): string | null {
  for (const id of SCENARIOS) {
    const scenario = run.scenarios.find((row) => row.id === id);
    const analysis = scenario?.analysis;
    if (!scenario || scenario.verdict !== "FAIL") return `${id} did not fail`;
    if (!analysis || analysis.status !== "READY" || !ResultSchema.safeParse(analysis.result).success) {
      return `${id} has no ready analysis`;
    }
    if (!analysis.key) return `the source reports no analysis key for ${id}`;
    const steps = scenario.steps.filter((step) => step.actor !== "analyst");
    const expected = analysisKey({
      scenarioId: id,
      model: analysis.model,
      codeHash,
      traceSignature: traceSignature(steps, scenario.verdict, scenario.reason ?? ""),
    });
    if (expected !== analysis.key) return `the ${id} analysis was written for other store code`;
  }
  return null;
}

const ApiStepSchema = z.object({
  seq: z.number(),
  actor: z.string(),
  method: z.string().nullable(),
  path: z.string().nullable(),
  httpStatus: z.number().nullable(),
  fault: z.string().nullable(),
  responseBody: z.unknown(),
});

const ApiReportSchema = z.object({
  id: z.uuid(),
  mode: z.string(),
  status: z.string(),
  finishedAt: z.string().nullable(),
  scenarios: z.array(
    z.object({
      id: z.string(),
      verdict: z.string().nullable(),
      reason: z.string().nullable(),
      headline: z.string().nullable(),
      steps: z.array(ApiStepSchema).default([]),
      analysis: z
        .object({
          key: z.string().nullable().default(null),
          status: z.string(),
          model: z.string(),
          completedAt: z.string().nullable(),
          patchStatus: z.string().nullable(),
          patchNote: z.string().nullable().default(null),
          result: z.unknown(),
        })
        .nullable(),
    }),
  ),
});

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), cache: "no-store" });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response.json();
}

/** Completed naive runs from a deployment's public API, newest first. */
async function* fromApi(base: string, runId?: string): AsyncGenerator<RunCandidate> {
  const ids = runId
    ? [runId]
    : z
        .object({ runs: z.array(z.object({ id: z.uuid(), mode: z.string(), status: z.string() })) })
        .parse(await getJson(`${base}/api/runs`))
        .runs.filter((run) => run.mode === "naive" && run.status === "COMPLETED")
        .map((run) => run.id);
  for (const id of ids) {
    const report = ApiReportSchema.parse(await getJson(`${base}/api/runs/${id}/report`));
    yield { id: report.id, finishedAt: report.finishedAt, link: `${base}/proof/${report.id}`, scenarios: report.scenarios };
  }
}

/** Completed naive runs from the database, newest first. */
async function* fromDatabase(runId?: string): AsyncGenerator<RunCandidate> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const { listRuns, readRun, readTrace } = await import("../lib/proof/repository");
  const { readAnalyses } = await import("../lib/ai/repository");
  const ids = runId
    ? [runId]
    : (await listRuns(20)).filter((run) => run.mode === "naive" && run.status === "COMPLETED").map((run) => run.id);
  for (const id of ids) {
    const found = await readRun(id);
    if (!found) continue;
    const trace = await readTrace(id);
    const analyses = await readAnalyses(found.scenarios.flatMap((row) => (row.analysisKey ? [row.analysisKey] : [])));
    yield {
      id,
      finishedAt: found.run.finishedAt?.toISOString() ?? null,
      link: `https://integration-proof.onrender.com/proof/${id}`,
      scenarios: found.scenarios.map((row) => {
        const analysis = analyses.find((candidate) => candidate.key === row.analysisKey);
        return {
          id: row.scenarioId,
          verdict: row.verdict,
          reason: row.reason,
          headline: row.headline,
          steps: trace.filter((step) => step.scenarioId === row.scenarioId),
          analysis: analysis
            ? {
                key: analysis.key,
                status: analysis.status,
                model: analysis.model,
                completedAt: analysis.completedAt?.toISOString() ?? null,
                patchStatus: analysis.patchStatus,
                patchNote: analysis.patchNote,
                result: analysis.result,
              }
            : null,
        };
      }),
    };
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { url: { type: "string" }, run: { type: "string" } } });
  const runId = values.run ? z.uuid().parse(values.run) : undefined;
  const { hash: codeHash } = await readStoreSources("naive");

  let chosen: RunCandidate | null = null;
  const source = values.url ? fromApi(new URL(values.url).origin, runId) : fromDatabase(runId);
  for await (const run of source) {
    const why = rejection(run, codeHash);
    if (!why) {
      chosen = run;
      break;
    }
    console.log(`Skipped run ${run.id}: ${why}.`);
  }
  if (!chosen) throw new Error("No completed naive run has analyses of S2 to S6 written for the current store code.");

  mkdirSync(OUT_DIR, { recursive: true });
  const meta: Record<string, unknown> = {};
  for (const id of SCENARIOS) {
    const scenario = chosen.scenarios.find((row) => row.id === id)!;
    const analysis = scenario.analysis!;
    const result = ResultSchema.parse(analysis.result);
    const patch = result.fix.patch.endsWith("\n") ? result.fix.patch : `${result.fix.patch}\n`;
    if (SECRET_PATTERNS.some((pattern) => pattern.test(patch) || pattern.test(result.fix.summary))) {
      throw new Error(`The ${id} analysis contains text that looks like a credential; nothing was written.`);
    }
    writeFileSync(path.join(OUT_DIR, `${id}.patch`), patch);
    meta[id] = {
      patch: `${id}.patch`,
      headline: scenario.headline,
      model: analysis.model,
      analyzedAt: analysis.completedAt,
      confidence: result.confidence,
      patchStatus: analysis.patchStatus,
      patchNote: analysis.patchNote,
      selfCheck: result.fix.selfCheck ?? null,
      fixSummary: result.fix.summary,
    };
  }

  writeFileSync(
    path.join(OUT_DIR, "meta.json"),
    `${JSON.stringify(
      {
        source: chosen.link,
        runId: chosen.id,
        runFinishedAt: chosen.finishedAt,
        target: TARGET,
        // The analyses were written for exactly this file: their cache keys match it.
        targetSha256: createHash("sha256").update(readFileSync(TARGET, "utf8")).digest("hex"),
        // The store code and the analyst's context they were written for, and the analysis format.
        // verify-ai-fixes compares both with the checkout, offline.
        codeHash,
        analysisFormat: ANALYSIS_FORMAT,
        scenarios: meta,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Saved the fixes of run ${chosen.id} to ${OUT_DIR}/.`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
