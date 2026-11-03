// The report of a run: every scenario with its verdict and its trace, step by step.
import { z } from "zod";
import { errorResponse, jsonError } from "@/lib/http";
import { readRun, readTrace } from "@/lib/proof/repository";
import { runView, stepView } from "@/lib/proof/views";

export async function GET(_request: Request, context: RouteContext<"/api/runs/[runId]/report">) {
  const runId = z.uuid().safeParse((await context.params).runId);
  if (!runId.success) return jsonError(404, "unknown_run", "No such run.");

  try {
    const found = await readRun(runId.data);
    if (!found) return jsonError(404, "unknown_run", "No such run.");
    const steps = await readTrace(runId.data);
    const view = runView(found.run, found.scenarios);
    return Response.json(
      {
        ...view,
        scenarios: view.scenarios.map((scenario) => ({
          ...scenario,
          steps: steps.filter((step) => step.scenarioId === scenario.id).map(stepView),
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
