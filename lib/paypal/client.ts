// PayPal fetch client. Receives baseUrl per call; only api-m.sandbox.paypal.com is allowed.
import { z } from "zod";

export const SANDBOX_API_BASE = "https://api-m.sandbox.paypal.com";

/** Hosts a PayPal call may reach. Anything else throws before a request leaves the process. */
const ALLOWED_BASE_URLS = new Set([SANDBOX_API_BASE]);

export function assertAllowedBaseUrl(baseUrl: string): void {
  if (!ALLOWED_BASE_URLS.has(baseUrl)) {
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
