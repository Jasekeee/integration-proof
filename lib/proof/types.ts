// Shapes shared by the runner, the trace and the assertions.
import type { OrderStatus } from "../db/schema";

/**
 * buyer: the headless buyer. store: the store's PayPal calls, seen by the proxy. runner: checks.
 * analyst: Claude's calls after the verdict; they are never evidence for the verdict itself.
 */
export type Actor = "buyer" | "store" | "runner" | "analyst";
export const ACTORS = ["buyer", "store", "runner", "analyst"] as const satisfies readonly Actor[];

/** The part of a trace step the assertions read. */
export interface TraceEntry {
  seq: number;
  actor: Actor;
  method: string | null;
  path: string | null;
  httpStatus: number | null;
  fault: string | null;
  responseBody: unknown;
}

/** The webhook router the runner delivers recorded or forged events to. */
export const WEBHOOK_ROUTER_PATH = "/api/store/webhooks-router";
/** Trace fault of a recorded PayPal delivery the runner sends again, byte for byte (S4, S5). */
export const REPLAYED_DELIVERY = "Replayed PayPal delivery";
/** Trace fault of a recorded delivery whose body the runner changed after PayPal signed it (S6). */
export const FORGED_DELIVERY = "Forged delivery: body changed after PayPal signed it";

/** What the store believes about one order of the cart, from its state contract. */
export interface StoreOrderState {
  paypalOrderId: string;
  status: OrderStatus;
  fulfilments: number;
}

/** What PayPal reports for one order of the cart. This is the source of truth. */
export interface PayPalOrderTruth {
  id: string;
  status: string;
  captures: { id: string; status: string }[];
}

export interface ScenarioState {
  store: StoreOrderState[];
  paypal: PayPalOrderTruth[];
  /** The store's state just before the runner's forged delivery (S6). */
  storeBefore?: StoreOrderState[];
}

/** Assertions decide PASS or FAIL. INCONCLUSIVE comes from the runner, when PayPal never delivered. */
export interface AssertionResult {
  verdict: "PASS" | "FAIL";
  reason: string;
}

/** Deterministic: the same trace and state always give the same verdict. */
export type Assertion = (trace: TraceEntry[], state: ScenarioState) => AssertionResult;
