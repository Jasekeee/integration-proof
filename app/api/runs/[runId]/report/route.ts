// The report of a run: every scenario with its verdict, its analysis and its trace, step by step.
import { z } from "zod";
import { errorResponse, jsonError } from "@/lib/http";
import { readReport } from "@/lib/proof/report";

export async function GET(_request: Request, context: RouteContext<"/api/runs/[runId]/report">) {
  const runId = z.uuid().safeParse((await context.params).runId);
  if (!runId.success) return jsonError(404, "unknown_run", "No such run.");

  try {
    const report = await readReport(runId.data);
    if (!report) return jsonError(404, "unknown_run", "No such run.");
    return Response.json(report, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
