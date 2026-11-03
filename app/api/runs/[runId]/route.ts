// Poll the status of a run and its scenarios.
import { z } from "zod";
import { errorResponse, jsonError } from "@/lib/http";
import { readRun } from "@/lib/proof/repository";
import { runView } from "@/lib/proof/views";

export async function GET(_request: Request, context: RouteContext<"/api/runs/[runId]">) {
  const runId = z.uuid().safeParse((await context.params).runId);
  if (!runId.success) return jsonError(404, "unknown_run", "No such run.");

  try {
    const found = await readRun(runId.data);
    if (!found) return jsonError(404, "unknown_run", "No such run.");
    return Response.json(runView(found.run, found.scenarios), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
