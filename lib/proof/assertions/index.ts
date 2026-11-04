// Pure functions: (trace, state) -> { verdict, reason }. The model never decides a verdict.
import { z } from "zod";
import { ORDER_STATUSES, type OrderStatus } from "../../db/schema";
import {
  FORGED_DELIVERY,
  REPLAYED_DELIVERY,
  WEBHOOK_ROUTER_PATH,
  type Assertion,
  type AssertionResult,
  type PayPalOrderTruth,
  type StoreOrderState,
  type TraceEntry,
} from "../types";

/** A capture that took the buyer's money, whether or not it was refunded later. */
const CHARGED_CAPTURE_STATUSES = new Set(["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"]);

/** Completed captures across every order created for the cart, as PayPal reports them. */
export function chargesPerCart(paypal: PayPalOrderTruth[]): number {
  return paypal.flatMap((order) => order.captures).filter((capture) => CHARGED_CAPTURE_STATUSES.has(capture.status))
    .length;
}

function isCharged(order: PayPalOrderTruth): boolean {
  return order.captures.some((capture) => CHARGED_CAPTURE_STATUSES.has(capture.status));
}

/** The status a store should report for an order, from PayPal's latest capture. */
const STATUS_FROM_CAPTURE: Record<string, OrderStatus> = {
  COMPLETED: "PAID",
  PARTIALLY_REFUNDED: "PAID",
  REFUNDED: "REFUNDED",
  PENDING: "PENDING",
  DECLINED: "DECLINED",
  FAILED: "FAILED",
};

const BUYER_CAPTURE_PATH = /^\/api\/store\/(naive|hardened)\/orders\/([A-Z0-9]+)\/capture$/;
const BUYER_CREATE_PATH = /^\/api\/store\/(naive|hardened)\/orders$/;
const PAYPAL_CAPTURE_PATH = /^\/v2\/checkout\/orders\/[A-Z0-9]+\/capture$/;

const BuyerAnswerSchema = z.object({ status: z.enum(ORDER_STATUSES), message: z.string() });
const RouterAnswerSchema = z.object({ outcome: z.string() });

/** The buyer's capture requests to the store, with the store's answers. */
function buyerCaptures(trace: TraceEntry[]): TraceEntry[] {
  return trace.filter(
    (step) => step.actor === "buyer" && step.method === "POST" && BUYER_CAPTURE_PATH.test(step.path ?? ""),
  );
}

function buyerCheckouts(trace: TraceEntry[]): number {
  return trace.filter((step) => step.actor === "buyer" && step.method === "POST" && BUYER_CREATE_PATH.test(step.path ?? ""))
    .length;
}

/** The store's capture requests to PayPal, as the proxy saw them. */
function storeCaptures(trace: TraceEntry[]): TraceEntry[] {
  return trace.filter(
    (step) => step.actor === "store" && step.method === "POST" && PAYPAL_CAPTURE_PATH.test(step.path ?? ""),
  );
}

/** Deliveries the runner sent the webhook router, of one kind. */
function runnerDeliveries(trace: TraceEntry[], kind: string): TraceEntry[] {
  return trace.filter(
    (step) => step.actor === "runner" && step.method === "POST" && step.path === WEBHOOK_ROUTER_PATH && step.fault === kind,
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describeStatus(status: number | null): string {
  return status === null ? "no response" : `HTTP ${status}`;
}

function describeRequests(steps: TraceEntry[]): string {
  if (steps.length === 0) return "no capture request to PayPal";
  return `${plural(steps.length, "capture request")} to PayPal: ${steps.map((step) => describeStatus(step.httpStatus)).join(", then ")}`;
}

function describeDelivery(step: TraceEntry): string {
  const outcome = RouterAnswerSchema.safeParse(step.responseBody).data?.outcome;
  return `${describeStatus(step.httpStatus)}${outcome ? `, outcome ${outcome}` : ""}`;
}

function pass(reason: string): AssertionResult {
  return { verdict: "PASS", reason };
}

function fail(problems: string[], context = ""): AssertionResult {
  const sentence = problems.join("; ");
  return { verdict: "FAIL", reason: `${sentence[0].toUpperCase()}${sentence.slice(1)}.${context}` };
}

/** Why the buyer's last answer is not a decline, or null when it is one. */
function declineProblem(answer: TraceEntry | undefined): string | null {
  if (!answer) return "the buyer's capture request is missing from the trace";
  if (answer.httpStatus === null) return "the buyer's capture request got no response";
  if (answer.httpStatus >= 500) return `the buyer got HTTP ${answer.httpStatus} instead of a decline`;
  const body = BuyerAnswerSchema.safeParse(answer.responseBody);
  if (!body.success) return `the buyer got HTTP ${answer.httpStatus} with no payment status`;
  if (body.data.status !== "DECLINED") {
    return `the buyer was told "${body.data.message}" (${body.data.status}) instead of a decline`;
  }
  return null;
}

/** Problems with orders PayPal charged but the store does not call PAID. */
function unpaidCharges(store: StoreOrderState[], paypal: PayPalOrderTruth[]): string[] {
  return paypal.filter(isCharged).flatMap((truth) => {
    const order = store.find((row) => row.paypalOrderId === truth.id);
    if (!order) return [`the store has no order ${truth.id}, which PayPal charged`];
    return order.status === "PAID" ? [] : [`the store marked order ${truth.id} ${order.status}`];
  });
}

/** S1, capture declined: order not PAID, the buyer sees a decline, and nothing is charged. */
export const assertS1: Assertion = (trace, state) => {
  const problems: string[] = [];
  const paid = state.store.find((order) => order.status === "PAID");
  if (paid) problems.push(`the store marked order ${paid.paypalOrderId} PAID`);
  const decline = declineProblem(buyerCaptures(trace).at(-1));
  if (decline) problems.push(decline);
  const charges = chargesPerCart(state.paypal);
  if (charges !== 0) problems.push(`PayPal shows ${plural(charges, "charge")} for the cart`);

  if (problems.length > 0) return fail(problems);
  return pass("The order stayed unpaid, the buyer was told the card was declined, and PayPal shows no charge for the cart.");
};

/** S2, transient 5xx on capture: the order ends PAID with exactly one charge. */
export const assertS2: Assertion = (trace, state) => {
  const problems: string[] = [];
  const charges = chargesPerCart(state.paypal);
  if (charges !== 1) problems.push(`PayPal shows ${plural(charges, "charge")} for the cart, not 1`);
  if (state.store.length === 0) problems.push("the store has no order for the cart");
  for (const order of state.store) {
    if (order.status !== "PAID") problems.push(`the store marked order ${order.paypalOrderId} ${order.status}`);
  }

  const context = ` The store sent ${describeRequests(storeCaptures(trace))}.`;
  if (problems.length > 0) return fail(problems, context);
  return pass(`The order is PAID with exactly 1 charge at PayPal.${context}`);
};

/** S3, lost response after a successful capture: one charge for the cart, and the order PAID. */
export const assertS3: Assertion = (trace, state) => {
  const problems: string[] = [];
  const charges = chargesPerCart(state.paypal);
  if (charges !== 1) problems.push(`PayPal shows ${plural(charges, "charge")} for the cart, not 1`);
  if (charges === 0) problems.push("nothing was captured, so the lost response was never tested");

  // What the buyer was told at checkout, against what PayPal had done.
  for (const step of buyerCaptures(trace)) {
    const orderId = BUYER_CAPTURE_PATH.exec(step.path ?? "")?.[2];
    const answer = BuyerAnswerSchema.safeParse(step.responseBody).data;
    const truth = state.paypal.find((order) => order.id === orderId);
    if (truth && isCharged(truth) && answer && answer.status !== "PAID" && answer.status !== "PENDING") {
      problems.push(`the store told the buyer "${answer.message}" for order ${orderId}, which PayPal had captured`);
    }
  }
  problems.push(...unpaidCharges(state.store, state.paypal));

  const context = ` The buyer checked out ${plural(buyerCheckouts(trace), "time")}.`;
  if (problems.length > 0) return fail(problems, context);
  return pass(`The order is PAID with exactly 1 charge at PayPal.${context}`);
};

/** S4, duplicate webhook: the same real PAYMENT.CAPTURE.COMPLETED twice, the order fulfilled once. */
export const assertS4: Assertion = (trace, state) => {
  const replay = runnerDeliveries(trace, REPLAYED_DELIVERY).at(-1);
  if (!replay) return fail(["the replayed delivery is missing from the trace"]);
  const problems: string[] = [];
  if (state.store.length === 0) problems.push("the store has no order for the cart");
  for (const order of state.store) {
    if (order.fulfilments !== 1) problems.push(`order ${order.paypalOrderId} was fulfilled ${plural(order.fulfilments, "time")}`);
  }

  const context = ` The replayed PAYMENT.CAPTURE.COMPLETED got ${describeDelivery(replay)}.`;
  if (problems.length > 0) return fail(problems, context);
  return pass(`The order was fulfilled once although PAYMENT.CAPTURE.COMPLETED arrived twice.${context}`);
};

/** S5, out-of-order webhooks: the store's final state equals PayPal's, after a stale event arrives last. */
export const assertS5: Assertion = (trace, state) => {
  const problems: string[] = [];
  const refunded = state.paypal.filter((order) => order.captures.some((capture) => capture.status === "REFUNDED"));
  if (refunded.length === 0) problems.push("PayPal shows no refunded capture for the cart, so nothing arrived out of order");
  if (runnerDeliveries(trace, REPLAYED_DELIVERY).length === 0) {
    problems.push("the late PAYMENT.CAPTURE.COMPLETED is missing from the trace");
  }
  for (const truth of state.paypal) {
    const capture = truth.captures.at(-1);
    const expected = capture ? STATUS_FROM_CAPTURE[capture.status] : undefined;
    const order = state.store.find((row) => row.paypalOrderId === truth.id);
    if (!order) problems.push(`the store has no order ${truth.id}`);
    else if (capture && expected && order.status !== expected) {
      problems.push(`the store reports order ${truth.id} ${order.status}, but PayPal reports its capture ${capture.status}`);
    }
  }

  if (problems.length > 0) return fail(problems);
  return pass(
    "The store reports the order REFUNDED, as PayPal does, although a PAYMENT.CAPTURE.COMPLETED arrived after the refund.",
  );
};

function describeOrder(order: StoreOrderState): string {
  return `${order.status} with ${plural(order.fulfilments, "fulfilment")}`;
}

/** S6, forged webhook: rejected with a 4xx, and the store's state is unchanged. */
export const assertS6: Assertion = (trace, state) => {
  const forged = runnerDeliveries(trace, FORGED_DELIVERY).at(-1);
  if (!forged) return fail(["the forged delivery is missing from the trace"]);
  if (!state.storeBefore) return fail(["the store's state before the forged delivery is missing"]);
  const problems: string[] = [];
  const status = forged.httpStatus;
  if (status === null || status < 400 || status >= 500) {
    problems.push(`the store answered the forged event with ${describeDelivery(forged)} instead of a 4xx`);
  }
  for (const after of state.store) {
    const before = state.storeBefore.find((row) => row.paypalOrderId === after.paypalOrderId);
    if (!before) problems.push(`order ${after.paypalOrderId} appeared after the forged event`);
    else if (before.status !== after.status || before.fulfilments !== after.fulfilments) {
      problems.push(`order ${after.paypalOrderId} changed from ${describeOrder(before)} to ${describeOrder(after)}`);
    }
  }

  if (problems.length > 0) return fail(problems);
  return pass(`The store rejected the forged event with ${describeDelivery(forged)}, and the order did not change.`);
};
