// Executes the scenarios of a run side by side and writes every step to the trace.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  ORDER_STATUSES,
  type OrderStatus,
  type RunRow,
  type RunScenarioRow,
  type StoreMode,
  type TraceStepRow,
} from "../db/schema";
import { internalOrigin } from "../origin";
import { SANDBOX_API_BASE, type PayPalResponse } from "../paypal/client";
import {
  capturesOf,
  confirmPaymentSource,
  getOrder,
  ORDERS_PATH,
  PayPalOrderSchema,
  type CallContext,
} from "../paypal/orders";
import { CAPTURES_PATH, refundCapture } from "../paypal/payments";
import { SANDBOX_TEST_CARD } from "../paypal/test-cards";
import { getAccessToken } from "../paypal/token";
import { analyzeScenario } from "../ai/jobs";
import { INCONCLUSIVE_HEADLINE, inconclusiveReason } from "./assertions";
import { redact, traceBody } from "./redact";
import { HEARTBEAT_MS } from "./lease";
import { attemptNote, exhaustedMessage, withRetries } from "./retry";
import {
  findAcknowledgedDelivery,
  markRunFinished,
  markRunStarted,
  nextSeq,
  readTrace,
  renewLease,
  updateScenario,
  writeStep,
  type StepRecord,
} from "./repository";
import { SCENARIOS, ScenarioIdSchema, type Scenario } from "./scenarios";
import {
  ACTORS,
  FORGED_DELIVERY,
  REPLAYED_DELIVERY,
  WEBHOOK_ROUTER_PATH,
  type Actor,
  type PayPalOrderTruth,
  type StoreOrderState,
  type TraceEntry,
} from "./types";

/** The hardened store may spend three attempts, backoff and a GET on one capture. */
const STORE_TIMEOUT_MS = 90_000;
const PAYPAL_TIMEOUT_MS = 30_000;
/** docs/decisions.md, "INCONCLUSIVE when PayPal does not deliver in time". */
export const WEBHOOK_WAIT_MS = 150_000;
const WEBHOOK_POLL_MS = 3_000;
const CAPTURE_COMPLETED = "PAYMENT.CAPTURE.COMPLETED";
const CAPTURE_REFUNDED = "PAYMENT.CAPTURE.REFUNDED";

interface ScenarioContext {
  runId: string;
  scenarioId: string;
  mode: StoreMode;
  cartId: string;
  runKey: string;
}

/** A scenario that cannot reach a verdict, for example because PayPal could not be read. */
class ScenarioAbort extends Error {}

const ACTIVE_GLOBAL = "integrationProofActiveRuns";

/**
 * The runs this process is executing. Kept on globalThis because instrumentation.ts, which ends them
 * on SIGTERM, is bundled apart from the routes that start them.
 */
export function activeRuns(): Set<string> {
  const store = globalThis as typeof globalThis & { [ACTIVE_GLOBAL]?: Set<string> };
  store[ACTIVE_GLOBAL] ??= new Set();
  return store[ACTIVE_GLOBAL];
}

/** Renews the run's lease every HEARTBEAT_MS until stopped. A failed renewal is retried next beat. */
export function startHeartbeat(runId: string, everyMs = HEARTBEAT_MS): () => void {
  const timer = setInterval(() => {
    renewLease(runId).catch((error: unknown) => console.error(`Could not renew the lease of run ${runId}`, error));
  }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Runs every scenario of a queued run and records the outcome. Never throws. */
export async function executeRun(runId: string): Promise<void> {
  activeRuns().add(runId);
  const stopHeartbeat = startHeartbeat(runId);
  try {
    const { run, scenarios } = await markRunStarted(runId);
    // Each scenario has its own cart, so they cannot interfere and the run lasts as long as the
    // slowest one, which is usually the one waiting for a webhook.
    const analyses: Promise<void>[] = [];
    await Promise.all(scenarios.map((row) => runScenario(run, row, analyses)));
    await markRunFinished(runId, null);
    stopHeartbeat();
    activeRuns().delete(runId);
    // The run is finished for its viewers; analyses carry on, and this keeps the process on them.
    await Promise.allSettled(analyses);
  } catch (error) {
    console.error(`Run ${runId} failed`, error);
    await markRunFinished(runId, describe(error)).catch((cause: unknown) => console.error(cause));
  } finally {
    stopHeartbeat();
    activeRuns().delete(runId);
  }
}

async function runScenario(run: RunRow, row: RunScenarioRow, analyses: Promise<void>[]): Promise<void> {
  const ctx: ScenarioContext = {
    runId: run.id,
    scenarioId: row.scenarioId,
    mode: run.mode,
    cartId: row.cartId,
    runKey: row.runKey,
  };
  try {
    const scenario = SCENARIOS[ScenarioIdSchema.parse(row.scenarioId)];
    await updateScenario(ctx.runId, ctx.scenarioId, { status: "RUNNING", startedAt: new Date() });

    const first = await checkout(ctx);
    const orderIds = [first.orderId];
    if (scenario.buyerRetriesFailedPayment && first.answer === "FAILED") {
      // The store told the buyer the payment failed, so the buyer pays for the same cart again.
      orderIds.push((await checkout(ctx)).orderId);
    }

    let paypal = await readPayPal(ctx, orderIds);
    if (scenario.refundAfterCapture) {
      await refundCaptures(ctx, paypal);
      paypal = await readPayPal(ctx, orderIds);
    }

    const settled = await waitForWebhooks(ctx, paypal);
    if (scenario.needsWebhooks && settled.missing.length > 0) {
      // The store was never put to the test, so neither PASS nor FAIL would be honest.
      await updateScenario(ctx.runId, ctx.scenarioId, {
        status: "COMPLETED",
        verdict: "INCONCLUSIVE",
        reason: inconclusiveReason(settled.missing, WEBHOOK_WAIT_MS),
        headline: INCONCLUSIVE_HEADLINE,
        finishedAt: new Date(),
      });
      analyses.push(analyzeScenario(ctx.runId, ctx.scenarioId));
      return;
    }
    const storeBefore = await deliver(ctx, scenario, paypal, settled.state);
    const store = await readStoreState(ctx);
    const trace = (await readTrace(ctx.runId, ctx.scenarioId)).map(toEntry);

    const result = scenario.assert(trace, { store, paypal, storeBefore });
    await updateScenario(ctx.runId, ctx.scenarioId, {
      status: "COMPLETED",
      verdict: result.verdict,
      reason: result.reason,
      headline: result.headline,
      harm: result.harm,
      finishedAt: new Date(),
    });
    // Claude explains a failure after the verdict is recorded; the scenario does not wait for it.
    if (result.verdict === "FAIL") analyses.push(analyzeScenario(ctx.runId, ctx.scenarioId));
  } catch (error) {
    if (!(error instanceof ScenarioAbort)) console.error(`Scenario ${ctx.scenarioId} of run ${ctx.runId} failed`, error);
    await updateScenario(ctx.runId, ctx.scenarioId, {
      status: "ERROR",
      error: describe(error),
      finishedAt: new Date(),
    }).catch((cause: unknown) => console.error(cause));
  }
}

const CreatedSchema = z.object({ orderId: z.string().regex(/^[A-Z0-9]{1,36}$/) });
const CaptureAnswerSchema = z.object({ status: z.enum(ORDER_STATUSES) });

/** The headless buyer: the store creates the order, the buyer approves it, the store captures. */
async function checkout(ctx: ScenarioContext): Promise<{ orderId: string; answer: OrderStatus | null }> {
  // The run key makes the store send this order's PayPal calls through the scenario's proxy.
  const created = await callStore(ctx, "buyer", "POST", `/api/store/${ctx.mode}/orders`, {
    cartId: ctx.cartId,
    run: { runId: ctx.runId, runKey: ctx.runKey },
  });
  const order = CreatedSchema.safeParse(created.body);
  if (created.status !== 201 || !order.success) {
    throw new ScenarioAbort(`The store did not create an order (${describeStatus(created.status)}).`);
  }
  const orderId = order.data.orderId;

  const confirmed = await callPayPal(
    ctx,
    "buyer",
    { method: "POST", path: `${ORDERS_PATH}/${orderId}/confirm-payment-source`, body: { payment_source: { card: SANDBOX_TEST_CARD } } },
    (call) => confirmPaymentSource(call, { orderId, card: SANDBOX_TEST_CARD }),
  );
  const approved = confirmed.kind === "response" && PayPalOrderSchema.safeParse(confirmed.body).data?.status === "APPROVED";
  if (!approved) throw new ScenarioAbort(`PayPal did not approve the test card on order ${orderId}.`);

  // The store's answer is evidence for the assertion, whatever it is, so nothing is checked here.
  const captured = await callStore(ctx, "buyer", "POST", `/api/store/${ctx.mode}/orders/${orderId}/capture`);
  return { orderId, answer: CaptureAnswerSchema.safeParse(captured.body).data?.status ?? null };
}

/** PayPal's view of every order created for the cart. This is what the verdict trusts. */
async function readPayPal(ctx: ScenarioContext, orderIds: string[]): Promise<PayPalOrderTruth[]> {
  const truth: PayPalOrderTruth[] = [];
  for (const orderId of orderIds) {
    const response = await callPayPal(ctx, "runner", { method: "GET", path: `${ORDERS_PATH}/${orderId}` }, (call) =>
      getOrder(call, orderId),
    );
    const order = response.kind === "response" && response.status === 200 ? PayPalOrderSchema.safeParse(response.body).data : undefined;
    if (!order) throw new ScenarioAbort(`PayPal could not be read for order ${orderId}.`);
    truth.push({
      id: order.id,
      status: order.status,
      captures: capturesOf(order).map(({ id, status }) => ({ id, status })),
    });
  }
  return truth;
}

/** The merchant refunds every completed capture in full, as a refund from the PayPal dashboard would. */
async function refundCaptures(ctx: ScenarioContext, paypal: PayPalOrderTruth[]): Promise<void> {
  const captures = paypal.flatMap((order) => order.captures.filter((capture) => capture.status === "COMPLETED"));
  if (captures.length === 0) throw new ScenarioAbort("PayPal shows no completed capture to refund.");
  for (const capture of captures) {
    const requestId = randomUUID();
    const refunded = await callPayPal(
      ctx,
      "runner",
      { method: "POST", path: `${CAPTURES_PATH}/${capture.id}/refund`, body: {}, requestId },
      (call) => refundCapture(call, { captureId: capture.id, requestId }),
    );
    // 201 is a new refund; 200 is PayPal answering a retry with the refund an earlier attempt made.
    if (refunded.kind !== "response" || refunded.status < 200 || refunded.status >= 300) {
      throw new ScenarioAbort(`PayPal did not refund capture ${capture.id}.`);
    }
  }
}

const StateSchema = z.object({
  orders: z.array(
    z.object({
      id: z.string(),
      paypalOrderId: z.string(),
      status: z.enum(ORDER_STATUSES),
      fulfilments: z.number(),
    }),
  ),
  deliveries: z.array(
    z.object({
      orderId: z.string().nullable(),
      eventType: z.string().nullable(),
      verification: z.string(),
      outcome: z.string(),
      responseStatus: z.number(),
    }),
  ),
});
type StoreState = z.infer<typeof StateSchema>;

interface ExpectedEvent {
  paypalOrderId: string;
  eventType: string;
}

/** The webhooks PayPal sends for the cart: COMPLETED for every charge, REFUNDED for every refund. */
function expectedEvents(paypal: PayPalOrderTruth[]): ExpectedEvent[] {
  return paypal.flatMap((order) => {
    const statuses = new Set(order.captures.map((capture) => capture.status));
    const events: ExpectedEvent[] = [];
    if (["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"].some((status) => statuses.has(status))) {
      events.push({ paypalOrderId: order.id, eventType: CAPTURE_COMPLETED });
    }
    if (statuses.has("REFUNDED") || statuses.has("PARTIALLY_REFUNDED")) {
      events.push({ paypalOrderId: order.id, eventType: CAPTURE_REFUNDED });
    }
    return events;
  });
}

/**
 * Waits until the store has acknowledged every webhook PayPal sends for the cart, so the assertion
 * sees the state those webhooks leave behind. Ends at the deadline.
 */
async function waitForWebhooks(
  ctx: ScenarioContext,
  paypal: PayPalOrderTruth[],
): Promise<{ missing: string[]; state: StoreState | null }> {
  const expected = expectedEvents(paypal);
  if (expected.length === 0) return { missing: [], state: null };

  await updateScenario(ctx.runId, ctx.scenarioId, { status: "WAITING_FOR_WEBHOOK", waitingSince: new Date() });
  const span = await openStep(ctx);
  const deadline = Date.now() + WEBHOOK_WAIT_MS;
  let state: StoreState | null = null;
  let pending = expected;
  while (pending.length > 0 && Date.now() < deadline) {
    await sleep(Math.min(WEBHOOK_POLL_MS, deadline - Date.now()));
    // A poll never runs past the deadline, even when the store is slow to answer.
    const remaining = Math.max(0, deadline - Date.now());
    const polled = await Promise.race([fetchState(ctx), sleep(remaining).then(() => null)]);
    state = polled ?? state;
    if (state) pending = pending.filter((event) => !acknowledgement(state!, event));
  }

  const waited = ((Date.now() - span.startedAt.getTime()) / 1000).toFixed(1);
  const notes = expected.map((event) => {
    const delivery = state ? acknowledgement(state, event) : undefined;
    return delivery
      ? `${event.eventType} for order ${event.paypalOrderId} acknowledged: verification ${delivery.verification}, outcome ${delivery.outcome}.`
      : `No acknowledged ${event.eventType} for order ${event.paypalOrderId} within ${WEBHOOK_WAIT_MS / 1000} s.`;
  });
  await closeStep(ctx, span, {
    actor: "runner",
    note: `Waited ${waited} s for PayPal webhooks. ${notes.join(" ")}`,
    responseBody: state ? { deliveries: state.deliveries } : null,
  });
  await updateScenario(ctx.runId, ctx.scenarioId, { status: "RUNNING", waitingSince: null });
  return { missing: pending.map((event) => event.eventType), state };
}

/** The 2xx delivery of an event the store recorded for a PayPal order, if any. */
function acknowledgement(state: StoreState, event: ExpectedEvent) {
  const order = state.orders.find((row) => row.paypalOrderId === event.paypalOrderId);
  if (!order) return undefined;
  return state.deliveries.find(
    (delivery) =>
      delivery.orderId === order.id &&
      delivery.eventType === event.eventType &&
      delivery.responseStatus >= 200 &&
      delivery.responseStatus < 300,
  );
}

/**
 * S4 and S5 send a recorded PAYMENT.CAPTURE.COMPLETED again, byte for byte with its transmission
 * headers. S6 sends it with the body changed after PayPal signed it, and returns the state before.
 */
async function deliver(
  ctx: ScenarioContext,
  scenario: Scenario,
  paypal: PayPalOrderTruth[],
  settled: StoreState | null,
): Promise<StoreOrderState[] | undefined> {
  if (!scenario.delivery) return undefined;
  const state = settled ?? (await fetchState(ctx));
  const charged = paypal.filter((order) => expectedEvents([order]).some((event) => event.eventType === CAPTURE_COMPLETED));
  if (!state || charged.length === 0) throw new ScenarioAbort("The store has no captured order to deliver an event for.");

  const storeBefore = scenario.delivery === "forge" ? await readStoreState(ctx) : undefined;
  for (const truth of charged) {
    const order = state.orders.find((row) => row.paypalOrderId === truth.id);
    const recorded = order ? await findAcknowledgedDelivery(order.id, CAPTURE_COMPLETED) : undefined;
    if (!recorded) throw new ScenarioAbort(`The store has no recorded ${CAPTURE_COMPLETED} for order ${truth.id}.`);

    if (scenario.delivery === "replay") {
      await postToRouter(ctx, recorded.headers, recorded.body, REPLAYED_DELIVERY,
        `Sent event ${recorded.eventId} again, byte for byte with its original transmission headers.`);
    } else {
      const event = JSON.parse(recorded.body) as { event_type: string; resource: { status?: string } };
      event.event_type = CAPTURE_REFUNDED;
      event.resource.status = "REFUNDED";
      await postToRouter(ctx, recorded.headers, JSON.stringify(event), FORGED_DELIVERY,
        `Event ${recorded.eventId} with its original transmission headers, after event_type was changed to ` +
          `${CAPTURE_REFUNDED} and resource.status to REFUNDED.`);
    }
  }
  return storeBefore;
}

async function postToRouter(
  ctx: ScenarioContext,
  headers: Record<string, string>,
  body: string,
  kind: string,
  note: string,
): Promise<void> {
  const span = await openStep(ctx);
  let status: number | null = null;
  let responseBody: unknown = null;
  try {
    const response = await fetch(`${internalOrigin()}${WEBHOOK_ROUTER_PATH}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(PAYPAL_TIMEOUT_MS * 2),
      cache: "no-store",
    });
    status = response.status;
    responseBody = await response.json().catch(() => null);
  } catch (error) {
    note = `${note} The router did not answer: ${describe(error)}`;
  }
  await closeStep(ctx, span, {
    actor: "runner",
    method: "POST",
    path: WEBHOOK_ROUTER_PATH,
    httpStatus: status,
    fault: kind,
    requestBody: traceBody(body),
    responseBody: redact(responseBody),
    note,
  });
}

/** Only the orders this run created for the cart, so an order placed by anyone else cannot count. */
function statePath(ctx: ScenarioContext): string {
  return `/api/store/${ctx.mode}/state?cartId=${encodeURIComponent(ctx.cartId)}&runId=${ctx.runId}`;
}

/** One untraced poll of the store's state; null when the store could not be read this time. */
async function fetchState(ctx: ScenarioContext): Promise<StoreState | null> {
  try {
    const response = await fetch(`${internalOrigin()}${statePath(ctx)}`, {
      signal: AbortSignal.timeout(WEBHOOK_POLL_MS * 3),
      cache: "no-store",
    });
    return StateSchema.safeParse(await response.json()).data ?? null;
  } catch {
    return null;
  }
}

/** What the store believes, as a traced read of its state contract. */
async function readStoreState(ctx: ScenarioContext): Promise<StoreOrderState[]> {
  const read = await callStore(ctx, "runner", "GET", statePath(ctx));
  const state = StateSchema.safeParse(read.body);
  if (read.status !== 200 || !state.success) {
    throw new ScenarioAbort(`The store's state could not be read (${describeStatus(read.status)}).`);
  }
  return state.data.orders.map(({ paypalOrderId, status, fulfilments }) => ({ paypalOrderId, status, fulfilments }));
}

interface StepSpan {
  seq: number;
  startedAt: Date;
  startedMs: number;
}

async function openStep(ctx: ScenarioContext): Promise<StepSpan> {
  const seq = await nextSeq(ctx.runId, ctx.scenarioId);
  return { seq, startedAt: new Date(), startedMs: performance.now() };
}

async function closeStep(
  ctx: ScenarioContext,
  span: StepSpan,
  step: Omit<StepRecord, "startedAt" | "durationMs">,
): Promise<void> {
  const durationMs = Math.round(performance.now() - span.startedMs);
  await writeStep(ctx.runId, ctx.scenarioId, span.seq, { ...step, startedAt: span.startedAt, durationMs });
}

const StoreErrorBodySchema = z.object({ debugId: z.string() });

async function callStore(
  ctx: ScenarioContext,
  actor: Actor,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number | null; body: unknown }> {
  const span = await openStep(ctx);
  let status: number | null = null;
  let responseBody: unknown = null;
  let note: string | null = null;
  try {
    const response = await fetch(`${internalOrigin()}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
      cache: "no-store",
    });
    status = response.status;
    responseBody = await response.json().catch(() => null);
  } catch (error) {
    note = `The store did not answer: ${describe(error)}`;
  }
  await closeStep(ctx, span, {
    actor,
    method,
    path,
    httpStatus: status,
    debugId: StoreErrorBodySchema.safeParse(responseBody).data?.debugId ?? null,
    requestBody: body === undefined ? null : redact(body),
    responseBody: redact(responseBody),
    note,
  });
  return { status, body: responseBody };
}

/**
 * One of the runner's own PayPal calls, each attempt a trace step. A 5xx, a timeout or a network
 * error is retried with backoff; `send` carries the same PayPal-Request-Id on every attempt. When
 * every attempt fails the scenario ends in ERROR, because the sandbox, not the store, stopped it.
 */
async function callPayPal(
  ctx: ScenarioContext,
  actor: Actor,
  request: { method: "GET" | "POST"; path: string; body?: unknown; requestId?: string },
  send: (call: CallContext) => Promise<PayPalResponse>,
): Promise<PayPalResponse> {
  const result = await withRetries(async (attempt) => {
    const span = await openStep(ctx);
    const response = await sendWithToken(send);
    const lost = response.kind === "no_response" ? `No response from PayPal (${response.reason}): ${response.message}` : null;
    await closeStep(ctx, span, {
      actor,
      method: request.method,
      path: request.path,
      httpStatus: response.kind === "response" ? response.status : null,
      debugId: response.kind === "response" ? response.debugId : null,
      paypalRequestId: request.requestId ?? null,
      requestBody: request.body === undefined ? null : redact(request.body),
      responseBody: response.kind === "response" ? redact(response.body) : null,
      note: [attemptNote(attempt, response), lost].filter(Boolean).join(" ") || null,
    });
    return response;
  });
  if (result.exhausted) throw new ScenarioAbort(exhaustedMessage(request, result));
  return result.response;
}

/** A token that cannot be fetched is an attempt without a response, so it is retried like one. */
async function sendWithToken(send: (call: CallContext) => Promise<PayPalResponse>): Promise<PayPalResponse> {
  const startedMs = performance.now();
  let token: string;
  try {
    token = await getAccessToken();
  } catch (error) {
    return {
      kind: "no_response",
      reason: "network",
      message: `no access token: ${describe(error)}`,
      durationMs: Math.round(performance.now() - startedMs),
    };
  }
  return send({ baseUrl: SANDBOX_API_BASE, token, timeoutMs: PAYPAL_TIMEOUT_MS });
}

const ActorSchema = z.enum(ACTORS);

/** The prefix of every store route the runner calls: orders, capture, state and the webhook router. */
const STORE_ROUTES = "/api/store/";

/**
 * Where a step's request went. The runner sends its own requests to the store's routes or to
 * PayPal's API; a store step is the store's PayPal call, as the proxy saw it.
 */
function targetOf(row: TraceStepRow): TraceEntry["target"] {
  if (row.actor === "store") return "paypal";
  if (row.path?.startsWith(STORE_ROUTES)) return "store";
  if (row.path?.startsWith(ORDERS_PATH) || row.path?.startsWith(CAPTURES_PATH)) return "paypal";
  return null;
}

function toEntry(row: TraceStepRow): TraceEntry {
  return {
    seq: row.seq,
    actor: ActorSchema.parse(row.actor),
    method: row.method,
    path: row.path,
    httpStatus: row.httpStatus,
    fault: row.fault,
    responseBody: row.responseBody,
    target: targetOf(row),
  };
}

function describeStatus(status: number | null): string {
  return status === null ? "no response" : `HTTP ${status}`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
