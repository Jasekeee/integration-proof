// Pure functions: (trace, state) -> { verdict, reason }. The model never decides a verdict.
import { z } from "zod";
import { ORDER_STATUSES } from "../../db/schema";
import type { Assertion, AssertionResult, PayPalOrderTruth, TraceEntry } from "../types";

/** A capture that took the buyer's money, whether or not it was refunded later. */
const CHARGED_CAPTURE_STATUSES = new Set(["COMPLETED", "PARTIALLY_REFUNDED", "REFUNDED"]);

/** Completed captures across every order created for the cart, as PayPal reports them. */
export function chargesPerCart(paypal: PayPalOrderTruth[]): number {
  return paypal.flatMap((order) => order.captures).filter((capture) => CHARGED_CAPTURE_STATUSES.has(capture.status))
    .length;
}

const BUYER_CAPTURE_PATH = /^\/api\/store\/(naive|hardened)\/orders\/[A-Z0-9]+\/capture$/;
const PAYPAL_CAPTURE_PATH = /^\/v2\/checkout\/orders\/[A-Z0-9]+\/capture$/;

const BuyerAnswerSchema = z.object({ status: z.enum(ORDER_STATUSES), message: z.string() });

/** The buyer's capture requests to the store, with the store's answers. */
function buyerCaptures(trace: TraceEntry[]): TraceEntry[] {
  return trace.filter(
    (step) => step.actor === "buyer" && step.method === "POST" && BUYER_CAPTURE_PATH.test(step.path ?? ""),
  );
}

/** The store's capture requests to PayPal, as the proxy saw them. */
function storeCaptures(trace: TraceEntry[]): TraceEntry[] {
  return trace.filter(
    (step) => step.actor === "store" && step.method === "POST" && PAYPAL_CAPTURE_PATH.test(step.path ?? ""),
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describeRequests(steps: TraceEntry[]): string {
  if (steps.length === 0) return "no capture request to PayPal";
  const statuses = steps.map((step) => (step.httpStatus === null ? "no response" : `HTTP ${step.httpStatus}`));
  return `${plural(steps.length, "capture request")} to PayPal: ${statuses.join(", then ")}`;
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
