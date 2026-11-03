// Fault-injection proxy to api-m.sandbox.paypal.com. During a run the store sends its Orders v2
// calls here; the proxy injects the scenario's fault, forwards to the sandbox, and records the call.
// The URL carries the scenario's secret run key, so only the store, told by the runner, gets in.
import { z } from "zod";
import { jsonError } from "@/lib/http";
import { classifyProxiedRequest, describeFault, mockResponseHeader, sandboxUrl } from "@/lib/proof/proxy";
import { traceBody } from "@/lib/proof/redact";
import { claimProxyStep, writeStep } from "@/lib/proof/repository";
import { SCENARIOS, ScenarioIdSchema } from "@/lib/proof/scenarios";

const RunKeySchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Longer than the store's own timeout, so the store, not the proxy, decides when to give up. */
const UPSTREAM_TIMEOUT_MS = 60_000;

/** Request headers the store's PayPal client sends. Nothing else reaches PayPal. */
const FORWARDED_HEADERS = ["authorization", "content-type", "prefer", "paypal-request-id"];

type Context = RouteContext<"/api/proxy/[runId]/[runKey]/[...path]">;

export const GET = proxy;
export const POST = proxy;

async function proxy(request: Request, context: Context): Promise<Response> {
  const params = await context.params;
  const runId = z.uuid().safeParse(params.runId);
  const runKey = RunKeySchema.safeParse(params.runKey);
  if (!runId.success || !runKey.success) return jsonError(404, "not_found", "No such run or scenario.");

  const path = `/${params.path.map(encodeURIComponent).join("/")}`;
  const operation = classifyProxiedRequest(request.method, path);
  if (!operation) return jsonError(404, "not_proxied", "The proxy forwards only the Orders v2 calls a store makes.");

  const claim = await claimProxyStep(runId.data, runKey.data, operation === "capture");
  if (!claim) return jsonError(404, "not_found", "No such run or scenario.");
  const scenarioId = ScenarioIdSchema.parse(claim.scenarioId);

  const fault = SCENARIOS[scenarioId].fault({ operation, captureAttempt: claim.captureAttempt });
  const headers = new Headers();
  for (const name of FORWARDED_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (fault?.kind === "mock") headers.set("PayPal-Mock-Response", mockResponseHeader(fault.code));
  const requestBody = request.method === "POST" ? await request.text() : null;

  const startedAt = new Date();
  const startedMs = performance.now();
  let upstream: Response | null = null;
  let responseText = "";
  let note: string | null = null;
  try {
    upstream = await fetch(sandboxUrl(path), {
      method: request.method,
      headers,
      body: requestBody ?? undefined,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cache: "no-store",
      redirect: "manual",
    });
    responseText = await upstream.text();
  } catch (error) {
    note = `PayPal did not answer the proxied request: ${error instanceof Error ? error.message : String(error)}`;
  }
  const holding = fault?.kind === "hold_response" && upstream !== null;
  if (holding) {
    note = `PayPal answered; the proxy holds the answer for ${claim.proxyHoldMs} ms before passing it on.`;
  }

  try {
    await writeStep(runId.data, scenarioId, claim.seq, {
      actor: "store",
      startedAt,
      durationMs: Math.round(performance.now() - startedMs),
      method: request.method,
      path,
      httpStatus: upstream?.status ?? null,
      debugId: upstream?.headers.get("paypal-debug-id") ?? null,
      paypalRequestId: request.headers.get("paypal-request-id"),
      fault: fault ? describeFault(fault, claim.proxyHoldMs) : null,
      requestBody: traceBody(requestBody),
      responseBody: traceBody(responseText),
      note,
    });
  } catch (error) {
    // The store still gets PayPal's answer: a lost trace step must not change what the store sees.
    console.error("Could not record a proxied PayPal call", error);
  }

  if (!upstream) return jsonError(502, "upstream_unreachable", "PayPal did not answer the proxied request.");
  // The step is already in the trace, so the evidence does not depend on the store still waiting.
  if (holding) await new Promise((resolve) => setTimeout(resolve, claim.proxyHoldMs));
  const responseHeaders = new Headers({ "Cache-Control": "no-store" });
  for (const name of ["content-type", "paypal-debug-id"]) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders.set(name, value);
  }
  const empty = upstream.status === 204 || upstream.status === 304;
  return new Response(empty ? null : responseText, { status: upstream.status, headers: responseHeaders });
}
