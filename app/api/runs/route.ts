// Start a proof run, or list recent runs.
import { after } from "next/server";
import { z } from "zod";
import { errorResponse, invalidRequest, jsonError } from "@/lib/http";
import { createRun, listRuns } from "@/lib/proof/repository";
import { executeRun } from "@/lib/proof/runner";
import { SCENARIO_IDS, ScenarioIdSchema } from "@/lib/proof/scenarios";
import { runView } from "@/lib/proof/views";
import { DEFAULT_PROXY_HOLD_MS, DEFAULT_STORE_TIMEOUT_MS } from "@/lib/db/schema";
import { StoreModeSchema } from "@/lib/store";

/** The proxy must hold S3's answer past the store timeout, so the store gives up first. */
const HOLD_MARGIN_MS = DEFAULT_PROXY_HOLD_MS - DEFAULT_STORE_TIMEOUT_MS;

const BodySchema = z
  .object({
    mode: StoreModeSchema,
    scenarioIds: z
      .array(ScenarioIdSchema)
      .min(1)
      .transform((ids) => SCENARIO_IDS.filter((id) => ids.includes(id)))
      .default([...SCENARIO_IDS]),
    /** Timeout of the store's PayPal calls during the run. */
    storeTimeoutMs: z.number().int().min(1000).max(15_000).default(DEFAULT_STORE_TIMEOUT_MS),
    /** How long the proxy holds PayPal's answer in S3; the store timeout plus 2 s unless given. */
    proxyHoldMs: z.number().int().min(1000).max(30_000).optional(),
  })
  .transform((body) => ({ ...body, proxyHoldMs: body.proxyHoldMs ?? body.storeTimeoutMs + HOLD_MARGIN_MS }))
  .refine((body) => body.proxyHoldMs > body.storeTimeoutMs, {
    path: ["proxyHoldMs"],
    message: "proxyHoldMs must be longer than storeTimeoutMs, or S3 loses no response.",
  });

export async function POST(request: Request) {
  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return invalidRequest(body.error.issues);

  try {
    const { mode, scenarioIds, storeTimeoutMs, proxyHoldMs } = body.data;
    const result = await createRun(mode, scenarioIds, { storeTimeoutMs, proxyHoldMs });
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
