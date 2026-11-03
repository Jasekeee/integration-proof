// PayPal fetch client. Receives baseUrl per call: the PayPal sandbox, or the app's own
// fault-injection proxy, which forwards to the sandbox only.
import { z } from "zod";
import { internalOrigin } from "../origin";

export const SANDBOX_HOST = "api-m.sandbox.paypal.com";
export const SANDBOX_API_BASE = `https://${SANDBOX_HOST}`;

const PROXY_PATH = /^\/api\/proxy\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{64}$/;

/** Where the store sends its PayPal calls during one scenario of a run. */
export function proxyBaseUrl(runId: string, runKey: string): string {
  const baseUrl = `${internalOrigin()}/api/proxy/${runId}/${runKey}`;
  assertAllowedBaseUrl(baseUrl);
  return baseUrl;
}

function isProxyBaseUrl(baseUrl: string): boolean {
  const origin = internalOrigin();
  return baseUrl.startsWith(`${origin}/`) && PROXY_PATH.test(baseUrl.slice(origin.length));
}

/** The sandbox or the run's proxy. Anything else throws before a request leaves the process. */
export function assertAllowedBaseUrl(baseUrl: string): void {
  if (baseUrl !== SANDBOX_API_BASE && !isProxyBaseUrl(baseUrl)) {
    throw new Error(`PayPal base URL is not allowed: ${baseUrl}`);
  }
}

export interface PayPalRequest {
  baseUrl: string;
  method: "GET" | "POST";
  /** Starts with /v1/ or /v2/. */
  path: string;
  token: string;
  body?: unknown;
  /** Sent as is instead of `body`, for payloads that must not be re-serialised. */
  rawBody?: string;
  /** Sent as PayPal-Request-Id. */
  requestId?: string;
  timeoutMs: number;
}

export type PayPalResponse =
  | {
      kind: "response";
      status: number;
      body: unknown;
      debugId: string | null;
      durationMs: number;
    }
  | {
      /** The call ended without an HTTP response. PayPal may still have acted on it. */
      kind: "no_response";
      reason: "timeout" | "network";
      message: string;
      durationMs: number;
    };

export async function paypalRequest(request: PayPalRequest): Promise<PayPalResponse> {
  assertAllowedBaseUrl(request.baseUrl);
  if (!/^\/v[12]\//.test(request.path)) throw new Error(`Unexpected PayPal path: ${request.path}`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${request.token}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
  if (request.requestId) headers["PayPal-Request-Id"] = request.requestId;

  const startedAt = performance.now();
  const elapsed = () => Math.round(performance.now() - startedAt);
  try {
    const response = await fetch(`${request.baseUrl}${request.path}`, {
      method: request.method,
      headers,
      body: request.method === "POST" ? (request.rawBody ?? JSON.stringify(request.body ?? {})) : undefined,
      signal: AbortSignal.timeout(request.timeoutMs),
      cache: "no-store",
    });
    const text = await response.text();
    return {
      kind: "response",
      status: response.status,
      body: parseJson(text),
      debugId: response.headers.get("paypal-debug-id"),
      durationMs: elapsed(),
    };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      kind: "no_response",
      reason: timedOut ? "timeout" : "network",
      message: describeError(error),
      durationMs: elapsed(),
    };
  }
}

const ErrorBodySchema = z.object({
  name: z.string().optional(),
  details: z.array(z.object({ issue: z.string().optional() })).optional(),
});

/** PayPal `details[].issue` codes, or the error name when the body has no details. */
export function paypalIssues(body: unknown): string[] {
  const error = ErrorBodySchema.safeParse(body).data;
  if (!error) return [];
  const issues = (error.details ?? []).flatMap((detail) => detail.issue ?? []);
  return issues.length > 0 ? issues : error.name ? [error.name] : [];
}

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause;
  if (cause instanceof Error) {
    const code = "code" in cause ? String(cause.code) : cause.name;
    return `${code}: ${cause.message}`;
  }
  return `${error.name}: ${error.message}`;
}
