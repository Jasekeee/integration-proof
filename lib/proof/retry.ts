// Retries for the runner's own PayPal calls: the buyer's confirm-payment-source, the merchant's
// refund and the runner's order reads. They are not under test, so a slow or failing sandbox gets
// more attempts before it can stop a scenario. The store's calls through the proxy are never
// retried here: how the store handles a failure is what a scenario measures.
import type { PayPalResponse } from "../paypal/client";
import { backoffMs, sleep } from "../store/shared";

/** Attempts in all, the first included. */
export const RUNNER_PAYPAL_ATTEMPTS = 3;

/** A 5xx, a timeout or a network error: the same request may succeed on another attempt. */
export function isRetryable(response: PayPalResponse): boolean {
  return response.kind === "no_response" || response.status >= 500;
}

/** Delay after failed attempt `attempt` (1-based): 500 ms, then 1 s. */
export function retryDelayMs(attempt: number): number {
  return backoffMs(attempt);
}

export interface RetryResult {
  response: PayPalResponse;
  attempts: number;
  /** Every attempt failed in a way a retry could have fixed. */
  exhausted: boolean;
}

/**
 * Sends one logical request up to `attempts` times, waiting with backoff between attempts, and stops
 * at the first answer a retry cannot change: a 2xx, or a 4xx. `send` is called once per attempt and
 * must send the same request every time, with the same PayPal-Request-Id where it has one.
 */
export async function withRetries(
  send: (attempt: number) => Promise<PayPalResponse>,
  options: { attempts?: number; wait?: (ms: number) => Promise<void> } = {},
): Promise<RetryResult> {
  const attempts = options.attempts ?? RUNNER_PAYPAL_ATTEMPTS;
  const wait = options.wait ?? sleep;
  let response: PayPalResponse | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (attempt > 1) await wait(retryDelayMs(attempt - 1));
    response = await send(attempt);
    if (!isRetryable(response)) return { response, attempts: attempt, exhausted: false };
  }
  return { response: response!, attempts, exhausted: true };
}

function describeResponse(response: PayPalResponse): string {
  return response.kind === "response" ? `HTTP ${response.status}` : `no response (${response.reason})`;
}

/** The trace note of one attempt, or null for a single attempt that settled the request. */
export function attemptNote(attempt: number, response: PayPalResponse, attempts = RUNNER_PAYPAL_ATTEMPTS): string | null {
  const failed = isRetryable(response);
  if (!failed) return attempt === 1 ? null : `Attempt ${attempt} of ${attempts}.`;
  const prefix = `Attempt ${attempt} of ${attempts}: ${describeResponse(response)}.`;
  return attempt < attempts ? `${prefix} The runner tries again in ${retryDelayMs(attempt) / 1000} s.` : prefix;
}

/** The scenario's error once every attempt failed. */
export function exhaustedMessage(request: { method: string; path: string }, result: RetryResult): string {
  return (
    `PayPal sandbox did not respond after ${result.attempts} attempts: ` +
    `${request.method} ${request.path} ended with ${describeResponse(result.response)}.`
  );
}
