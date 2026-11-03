// Shapes shared by the runner, the trace and the assertions.
import type { OrderStatus, Verdict } from "../db/schema";

/** buyer: the headless buyer. store: the store's PayPal calls, seen by the proxy. runner: checks. */
export type Actor = "buyer" | "store" | "runner";

/** The part of a trace step the assertions read. */
export interface TraceEntry {
  seq: number;
  actor: Actor;
  method: string | null;
  path: string | null;
  httpStatus: number | null;
  responseBody: unknown;
}

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
}

export interface AssertionResult {
  verdict: Verdict;
  reason: string;
}

/** Deterministic: the same trace and state always give the same verdict. */
export type Assertion = (trace: TraceEntry[], state: ScenarioState) => AssertionResult;
