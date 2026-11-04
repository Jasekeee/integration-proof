// The full report of a run, as the report API returns it and the result pages render it.
import { readAnalyses } from "../ai/repository";
import type { StoreMode } from "../db/schema";
import { listRuns, readRun, readTrace } from "./repository";
import { runView, stepView } from "./views";

export async function readReport(runId: string) {
  const found = await readRun(runId);
  if (!found) return null;
  const steps = await readTrace(runId);
  const analyses = await readAnalyses(found.scenarios.flatMap((row) => (row.analysisKey ? [row.analysisKey] : [])));
  const view = runView(found.run, found.scenarios, analyses);
  return {
    ...view,
    scenarios: view.scenarios.map((scenario) => ({
      ...scenario,
      steps: steps.filter((step) => step.scenarioId === scenario.id).map(stepView),
    })),
  };
}

export type Report = NonNullable<Awaited<ReturnType<typeof readReport>>>;

/** The most recent run of each store, for the comparison page's first paint. */
export async function latestRunIds(): Promise<Record<StoreMode, string | null>> {
  const runs = await listRuns(20);
  return {
    naive: runs.find((run) => run.mode === "naive")?.id ?? null,
    hardened: runs.find((run) => run.mode === "hardened")?.id ?? null,
  };
}
