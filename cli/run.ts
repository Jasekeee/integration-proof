// Runs the checkout scenarios S1–S3 against a store that implements the contract, one after the
// other, through the CLI's local proxy. The verdicts come from the same deterministic assertions as
// the hosted proof (lib/proof/assertions); only the orchestration is the CLI's own.
import { randomUUID } from "node:crypto";
import type { PayPalResponse } from "../lib/paypal/client";
import { SANDBOX_API_BASE } from "../lib/paypal/client";
import { confirmPaymentSource, getOrder, ORDERS_PATH, PayPalOrderSchema, capturesOf, type CallContext } from "../lib/paypal/orders";
import { SANDBOX_TEST_CARD } from "../lib/paypal/test-cards";
import { getAccessToken } from "../lib/paypal/token";
import type { Harm } from "../lib/proof/harms";
import { redact } from "../lib/proof/redact";
import { attemptNote, exhaustedMessage, withRetries } from "../lib/proof/retry";
import { SCENARIOS, type Scenario } from "../lib/proof/scenarios";
import type { Actor, PayPalOrderTruth, StoreOrderState } from "../lib/proof/types";
import { CaptureAnswerSchema, contractPaths, CreatedSchema, StateSchema, type ContractScenarioId } from "./contract";
import type { LocalProxy } from "./proxy";
import { numbered, toEntry, type CliStep, type NumberedStep } from "./steps";

const PAYPAL_TIMEOUT_MS = 30_000;

export type CliVerdict = "PASS" | "FAIL" | "INCONCLUSIVE" | "ERROR";

export interface ScenarioResult {
  id: ContractScenarioId;
  title: string;
  passWhen: string;
  verdict: CliVerdict;
  headline: string;
  reason: string;
  harm: Harm | null;
  durationMs: number;
  steps: NumberedStep[];
}

export interface RunOptions {
  /** The store's contract base URL, its own prefix included: http://localhost:4000/integration-proof. */
  store: URL;
  scenarios: ContractScenarioId[];
  proxy: LocalProxy;
  holdMs: number;
  /** How long the buyer waits for the store to answer one request. */
  buyerTimeoutMs: number;
}

/** A scenario that cannot reach a verdict: the store broke the contract, or PayPal could not be read. */
class ScenarioAbort extends Error {}

export async function runScenarios(options: RunOptions): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const id of options.scenarios) results.push(await runScenario(id, options));
  return results;
}

async function runScenario(id: ContractScenarioId, options: RunOptions): Promise<ScenarioResult> {
  const scenario = SCENARIOS[id];
  const recorded: CliStep[] = [];
  const record = (step: CliStep) => recorded.push(step);
  const startedMs = performance.now();
  const base = () => ({ id, title: scenario.title, passWhen: scenario.passWhen, steps: numbered(recorded) });
  const ctx = { ...options, record, cartId: `cart-${randomUUID()}` };
  options.proxy.begin(scenario, record);
  try {
    const first = await checkout(ctx);
    const orderIds = [first.orderId];
    if (scenario.buyerRetriesFailedPayment && first.answer === "FAILED") {
      // The store told the buyer the payment failed, so the buyer pays for the same cart again.
      orderIds.push((await checkout(ctx)).orderId);
    }
    // A held answer is let through before the store is read, as PayPal's answer would arrive.
    await options.proxy.settle();
    const paypal = await readPayPal(ctx, orderIds);
    const store = await readStoreState(ctx);
    const durationMs = Math.round(performance.now() - startedMs);

    const trace = base();
    const untested = lostResponseUntested(scenario, trace.steps, options.holdMs);
    if (untested) return { ...trace, verdict: "INCONCLUSIVE", headline: "Lost response not tested", reason: untested, harm: null, durationMs };

    const result = scenario.assert(trace.steps.map(toEntry), { store, paypal });
    return { ...trace, ...result, durationMs };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ...base(), verdict: "ERROR", headline: "Could not run", reason, harm: null, durationMs: Math.round(performance.now() - startedMs) };
  } finally {
    await options.proxy.end();
  }
}

/**
 * S3 tests a store that stops waiting for PayPal before the answer arrives. A store that waited for
 * the held answer never saw a lost response, so neither PASS nor FAIL would be honest.
 */
function lostResponseUntested(scenario: Scenario, steps: NumberedStep[], holdMs: number): string | null {
  const held = steps.find((step) => step.actor === "store" && step.fault?.startsWith("Response held"));
  if (!held) return null;
  // The buyer's capture request that the held PayPal call was made for: the last one started before it.
  const answer = steps.findLast((step) => step.actor === "buyer" && step.target === "store" && step.seq < held.seq && step.path.endsWith("/capture"));
  if (!answer || answer.durationMs < holdMs) return null;
  return (
    `The store answered the buyer after ${(answer.durationMs / 1000).toFixed(1)} s, once the proxy had passed on ` +
    `PayPal's held answer, so it never saw a lost response. Give the store's PayPal client a timeout shorter ` +
    `than --hold-ms (${holdMs} ms) and run ${scenario.id} again.`
  );
}

type Ctx = RunOptions & { record: (step: CliStep) => void; cartId: string };

/** The headless buyer: the store creates the order, the buyer approves it, the store captures. */
async function checkout(ctx: Ctx): Promise<{ orderId: string; answer: string | null }> {
  const created = await callStore(ctx, "buyer", "POST", contractPaths.orders, { cartId: ctx.cartId });
  const order = CreatedSchema.safeParse(created.body);
  if (created.status !== 201 || !order.success) {
    throw new ScenarioAbort(
      `The store did not create an order: POST ${contractPaths.orders} answered ${describeStatus(created.status)}` +
        `${order.success ? "" : ", without an orderId"}; contract v1 expects 201 and {"orderId": "..."}.`,
    );
  }
  const orderId = order.data.orderId;

  const confirmed = await callPayPal(
    ctx,
    "buyer",
    { method: "POST", path: `${ORDERS_PATH}/${orderId}/confirm-payment-source`, body: { payment_source: { card: SANDBOX_TEST_CARD } } },
    (call) => confirmPaymentSource(call, { orderId, card: SANDBOX_TEST_CARD }),
  );
  const approved = confirmed.kind === "response" && PayPalOrderSchema.safeParse(confirmed.body).data?.status === "APPROVED";
  if (!approved) {
    throw new ScenarioAbort(
      `PayPal did not approve the test card on order ${orderId}. The store must create the order with intent ` +
        `CAPTURE and no payment source, with the same PayPal app whose credentials the CLI uses.`,
    );
  }

  // The store's answer is evidence for the assertion, whatever it is, so nothing is checked here.
  const captured = await callStore(ctx, "buyer", "POST", contractPaths.capture(orderId));
  return { orderId, answer: CaptureAnswerSchema.safeParse(captured.body).data?.status ?? null };
}

/** PayPal's view of every order created for the cart. This is what the verdict trusts. */
async function readPayPal(ctx: Ctx, orderIds: string[]): Promise<PayPalOrderTruth[]> {
  const truth: PayPalOrderTruth[] = [];
  for (const orderId of orderIds) {
    const response = await callPayPal(ctx, "runner", { method: "GET", path: `${ORDERS_PATH}/${orderId}` }, (call) => getOrder(call, orderId));
    const order = response.kind === "response" && response.status === 200 ? PayPalOrderSchema.safeParse(response.body).data : undefined;
    if (!order) throw new ScenarioAbort(`PayPal could not be read for order ${orderId}.`);
    truth.push({ id: order.id, status: order.status, captures: capturesOf(order).map(({ id, status }) => ({ id, status })) });
  }
  return truth;
}

/** What the store believes, from its state endpoint. */
async function readStoreState(ctx: Ctx): Promise<StoreOrderState[]> {
  const read = await callStore(ctx, "runner", "GET", contractPaths.state(ctx.cartId));
  const state = StateSchema.safeParse(read.body);
  if (read.status !== 200 || !state.success) {
    const problem = state.success ? "" : `: ${state.error.issues.map((issue) => `${issue.path.join(".") || "body"} ${issue.message}`).join("; ")}`;
    throw new ScenarioAbort(`The store's state does not follow contract v1 (${describeStatus(read.status)}${problem}).`);
  }
  return state.data.orders;
}

async function callStore(
  ctx: Ctx,
  actor: Actor,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number | null; body: unknown }> {
  const url = new URL(ctx.store.pathname.replace(/\/$/, "") + path, ctx.store);
  const startedAt = new Date();
  const startedMs = performance.now();
  let status: number | null = null;
  let responseBody: unknown = null;
  let note: string | null = null;
  try {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ctx.buyerTimeoutMs),
    });
    status = response.status;
    responseBody = await response.json().catch(() => null);
  } catch (error) {
    note = `The store did not answer: ${error instanceof Error ? error.message : String(error)}`;
  }
  ctx.record({
    startMs: startedMs,
    actor,
    target: "store",
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - startedMs),
    method,
    path: url.pathname + url.search,
    httpStatus: status,
    debugId: null,
    paypalRequestId: null,
    fault: null,
    requestBody: body === undefined ? null : redact(body),
    responseBody: redact(responseBody),
    note,
  });
  return { status, body: responseBody };
}

/** One of the CLI's own PayPal calls, retried on a 5xx or no answer; each attempt is a step. */
async function callPayPal(
  ctx: Ctx,
  actor: Actor,
  request: { method: "GET" | "POST"; path: string; body?: unknown },
  send: (call: CallContext) => Promise<PayPalResponse>,
): Promise<PayPalResponse> {
  const result = await withRetries(async (attempt) => {
    const startedAt = new Date();
    const startedMs = performance.now();
    const response = await sendWithToken(send);
    ctx.record({
      startMs: startedMs,
      actor,
      target: "paypal",
      startedAt: startedAt.toISOString(),
      durationMs: Math.round(performance.now() - startedMs),
      method: request.method,
      path: request.path,
      httpStatus: response.kind === "response" ? response.status : null,
      debugId: response.kind === "response" ? response.debugId : null,
      paypalRequestId: null,
      fault: null,
      requestBody: request.body === undefined ? null : redact(request.body),
      responseBody: response.kind === "response" ? redact(response.body) : null,
      note: [attemptNote(attempt, response), response.kind === "no_response" ? `No response from PayPal: ${response.message}` : null]
        .filter(Boolean)
        .join(" ") || null,
    });
    return response;
  });
  if (result.exhausted) throw new ScenarioAbort(exhaustedMessage(request, result));
  return result.response;
}

async function sendWithToken(send: (call: CallContext) => Promise<PayPalResponse>): Promise<PayPalResponse> {
  const startedMs = performance.now();
  let token: string;
  try {
    token = await getAccessToken();
  } catch (error) {
    return {
      kind: "no_response",
      reason: "network",
      message: `no access token: ${error instanceof Error ? error.message : String(error)}`,
      durationMs: Math.round(performance.now() - startedMs),
    };
  }
  return send({ baseUrl: SANDBOX_API_BASE, token, timeoutMs: PAYPAL_TIMEOUT_MS });
}

function describeStatus(status: number | null): string {
  return status === null ? "no response" : `HTTP ${status}`;
}
