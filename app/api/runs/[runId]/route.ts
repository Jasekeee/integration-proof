// Poll the status of a run and its scenarios.
import { z } from "zod";
import { errorResponse, jsonError } from "@/lib/http";
import { readAnalyses } from "@/lib/ai/repository";
import { readRun } from "@/lib/proof/repository";
import { runView } from "@/lib/proof/views";

export async function GET(_request: Request, context: RouteContext<"/api/runs/[runId]">) {
  const runId = z.uuid().safeParse((await context.params).runId);
  if (!runId.success) return jsonError(404, "unknown_run", "No such run.");

  try {
    const found = await readRun(runId.data);
    if (!found) return jsonError(404, "unknown_run", "No such run.");
    const analyses = await readAnalyses(found.scenarios.flatMap((row) => (row.analysisKey ? [row.analysisKey] : [])));
    return Response.json(runView(found.run, found.scenarios, analyses), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
