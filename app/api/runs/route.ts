// Start a proof run, or list recent runs.
import { after } from "next/server";
import { z } from "zod";
import { errorResponse, invalidRequest, jsonError } from "@/lib/http";
import { createRun, listRuns } from "@/lib/proof/repository";
import { executeRun } from "@/lib/proof/runner";
import { SCENARIO_IDS, ScenarioIdSchema } from "@/lib/proof/scenarios";
import { runView } from "@/lib/proof/views";
import { StoreModeSchema } from "@/lib/store";

const BodySchema = z.object({
  mode: StoreModeSchema,
  scenarioIds: z
    .array(ScenarioIdSchema)
    .min(1)
    .transform((ids) => SCENARIO_IDS.filter((id) => ids.includes(id)))
    .default([...SCENARIO_IDS]),
});

export async function POST(request: Request) {
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return invalidRequest(body.error.issues);

  try {
    const result = await createRun(body.data.mode, body.data.scenarioIds);
    if (result.kind === "busy") {
      return jsonError(429, "run_in_progress", "Another proof run is in progress. Try again when it finishes.", {
        runId: result.runId,
      });
    }
    if (result.kind === "rate_limited") {
      return Response.json(
        { error: "rate_limited", message: "The hourly run limit is reached. Try again later." },
        { status: 429, headers: { "Retry-After": String(result.retryAfterSeconds) } },
      );
    }

    // The run continues after the response: the client polls GET /api/runs/{runId}.
    after(() => executeRun(result.run.id));
    return Response.json(runView(result.run, result.scenarios), {
      status: 202,
      headers: { Location: `/api/runs/${result.run.id}` },
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET() {
  try {
    const runs = await listRuns(20);
    return Response.json(
      {
        runs: runs.map((run) => ({
          id: run.id,
          mode: run.mode,
          status: run.status,
          scenarioIds: run.scenarioIds,
          passed: run.passed,
          failed: run.failed,
          createdAt: run.createdAt,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
        })),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
