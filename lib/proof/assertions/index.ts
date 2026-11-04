// Pure functions: (trace, state) -> { verdict, reason }. The model never decides a verdict.
import { z } from "zod";
import { ORDER_STATUSES, type OrderStatus } from "../../db/schema";
import type { Harm } from "../harms";
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

function pass(reason: string, headline: string): AssertionResult {
  return { verdict: "PASS", reason, headline, harm: null };
}

/**
 * A failure. `harm` is what it cost, or null when the scenario never reached the behaviour it tests,
 * for example because a delivery is missing from the trace.
 */
function fail(problems: string[], context: string, outcome: { headline: string; harm: Harm | null }): AssertionResult {
  const sentence = problems.join("; ");
  return { verdict: "FAIL", reason: `${sentence[0].toUpperCase()}${sentence.slice(1)}.${context}`, ...outcome };
}

/** "Buyer charged twice", "Buyer charged 3 times", with the harm it counts as. */
function chargedTimes(count: number): { headline: string; harm: Harm } {
  return count === 2
    ? { headline: "Buyer charged twice", harm: "cart_charged_twice" }
    : { headline: `Buyer charged ${count} times`, harm: "cart_charged_repeatedly" };
}

/** The INCONCLUSIVE headline: the store was never tested, so nothing is said about it. */
export const INCONCLUSIVE_HEADLINE = "PayPal did not deliver in time";

/** Why the buyer's last answer is not a decline, or null when it is one. */
function declineProblem(answer: TraceEntry | undefined): { problem: string; crash: boolean } | null {
  if (!answer) return { problem: "the buyer's capture request is missing from the trace", crash: true };
  if (answer.httpStatus === null) return { problem: "the buyer's capture request got no response", crash: true };
  if (answer.httpStatus >= 500) {
    return { problem: `the buyer got HTTP ${answer.httpStatus} instead of a decline`, crash: true };
  }
  const body = BuyerAnswerSchema.safeParse(answer.responseBody);
  if (!body.success) return { problem: `the buyer got HTTP ${answer.httpStatus} with no payment status`, crash: true };
  if (body.data.status !== "DECLINED") {
    return {
      problem: `the buyer was told "${body.data.message}" (${body.data.status}) instead of a decline`,
      crash: false,
    };
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

/**
 * The reason of an INCONCLUSIVE verdict: PayPal did not deliver what the scenario needs in time, so
 * the store was never put to the test.
 */
export function inconclusiveReason(missingEvents: string[], deadlineMs: number): string {
  const events = [...new Set(missingEvents)];
  const list = events.length > 1 ? `${events.slice(0, -1).join(", ")} or ${events.at(-1)}` : events[0];
  return `PayPal did not deliver ${list} within ${Math.round(deadlineMs / 1000)} s.`;
}

/** S1, capture declined: order not PAID, the buyer sees a decline, and nothing is charged. */
export const assertS1: Assertion = (trace, state) => {
  const problems: string[] = [];
  const paid = state.store.find((order) => order.status === "PAID");
  if (paid) problems.push(`the store marked order ${paid.paypalOrderId} PAID`);
  const decline = declineProblem(buyerCaptures(trace).at(-1));
  if (decline) problems.push(decline.problem);
  const charges = chargesPerCart(state.paypal);
  if (charges !== 0) problems.push(`PayPal shows ${plural(charges, "charge")} for the cart`);

  if (problems.length > 0) {
    const outcome: { headline: string; harm: Harm } =
      charges > 0
        ? { headline: "Buyer charged on a declined card", harm: "declined_card_charged" }
        : paid
          ? { headline: "Declined payment marked paid", harm: "declined_payment_marked_paid" }
          : decline?.crash
            ? { headline: "Buyer saw an error instead of a decline", harm: "decline_shown_as_error" }
            : { headline: "Buyer not told the card was declined", harm: "decline_not_shown" };
    return fail(problems, "", outcome);
  }
  return pass(
    "The order stayed unpaid, the buyer was told the card was declined, and PayPal shows no charge for the cart.",
    "Decline shown, nothing charged",
  );
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
  if (problems.length > 0) {
    const outcome =
      charges === 0
        ? { headline: "Sale lost on a transient error", harm: "sale_lost" as const }
        : charges > 1
          ? chargedTimes(charges)
          : { headline: "Paid order shown as unpaid", harm: "paid_order_shown_as_unpaid" as const };
    return fail(problems, context, outcome);
  }
  return pass(`The order is PAID with exactly 1 charge at PayPal.${context}`, "Retried and charged once");
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
  if (problems.length > 0) {
    // With nothing captured the lost response was never tested, so no harm is claimed.
    const outcome =
      charges === 0
        ? { headline: "Capture never went through", harm: null }
        : charges > 1
          ? chargedTimes(charges)
          : { headline: "Paid order shown as failed", harm: "paid_order_shown_as_failed" as const };
    return fail(problems, context, outcome);
  }
  return pass(`The order is PAID with exactly 1 charge at PayPal.${context}`, "Charged once, no second checkout");
};

/** S4, duplicate webhook: the same real PAYMENT.CAPTURE.COMPLETED twice, the order fulfilled once. */
export const assertS4: Assertion = (trace, state) => {
  const replay = runnerDeliveries(trace, REPLAYED_DELIVERY).at(-1);
  if (!replay) {
    return fail(["the replayed delivery is missing from the trace"], "", { headline: "Replay never delivered", harm: null });
  }
  const problems: string[] = [];
  if (state.store.length === 0) problems.push("the store has no order for the cart");
  for (const order of state.store) {
    if (order.fulfilments !== 1) problems.push(`order ${order.paypalOrderId} was fulfilled ${plural(order.fulfilments, "time")}`);
  }

  const context = ` The replayed PAYMENT.CAPTURE.COMPLETED got ${describeDelivery(replay)}.`;
  if (problems.length > 0) {
    const most = Math.max(0, ...state.store.map((order) => order.fulfilments));
    const outcome: { headline: string; harm: Harm } =
      most > 2
        ? { headline: `Order shipped ${most} times`, harm: "order_shipped_repeatedly" }
        : most === 2
          ? { headline: "Order shipped twice", harm: "order_shipped_twice" }
          : most === 0
            ? { headline: "Paid order never shipped", harm: "paid_order_not_shipped" }
            : { headline: "Order not shipped once", harm: "paid_order_not_shipped" };
    return fail(problems, context, outcome);
  }
  return pass(`The order was fulfilled once although PAYMENT.CAPTURE.COMPLETED arrived twice.${context}`, "Shipped once");
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

  if (problems.length > 0) {
    const paidButRefunded = refunded.some(
      (truth) => state.store.find((row) => row.paypalOrderId === truth.id)?.status === "PAID",
    );
    const outcome: { headline: string; harm: Harm | null } =
      refunded.length === 0
        ? { headline: "Refund never happened", harm: null }
        : paidButRefunded
          ? { headline: "Refunded order shown as paid", harm: "refund_shown_as_paid" }
          : runnerDeliveries(trace, REPLAYED_DELIVERY).length === 0
            ? { headline: "Late event never delivered", harm: null }
            : { headline: "Order state differs from PayPal", harm: "order_out_of_sync" };
    return fail(problems, "", outcome);
  }
  return pass(
    "The store reports the order REFUNDED, as PayPal does, although a PAYMENT.CAPTURE.COMPLETED arrived after the refund.",
    "Shows refunded, as PayPal does",
  );
};

function describeOrder(order: StoreOrderState): string {
  return `${order.status} with ${plural(order.fulfilments, "fulfilment")}`;
}

/** S6, forged webhook: rejected with a 4xx, and the store's state is unchanged. */
export const assertS6: Assertion = (trace, state) => {
  const forged = runnerDeliveries(trace, FORGED_DELIVERY).at(-1);
  const neverDelivered = { headline: "Forgery never delivered", harm: null };
  if (!forged) return fail(["the forged delivery is missing from the trace"], "", neverDelivered);
  if (!state.storeBefore) return fail(["the store's state before the forged delivery is missing"], "", neverDelivered);
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

  if (problems.length > 0) {
    const accepted = status !== null && status >= 200 && status < 300;
    const changed = problems.some((problem) => problem.includes(" changed from ") || problem.includes(" appeared "));
    // An answer outside 2xx and 4xx neither accepts nor rejects the forgery; it costs nothing yet.
    const outcome: { headline: string; harm: Harm | null } = accepted
      ? changed
        ? { headline: "Forged refund accepted", harm: "forged_refund_accepted" }
        : { headline: "Forged event accepted", harm: "forged_event_accepted" }
      : changed
        ? { headline: "Forged event changed the order", harm: "forged_event_changed_order" }
        : { headline: "Forged event not rejected", harm: null };
    return fail(problems, "", outcome);
  }
  return pass(
    `The store rejected the forged event with ${describeDelivery(forged)}, and the order did not change.`,
    "Forged event rejected",
  );
};
