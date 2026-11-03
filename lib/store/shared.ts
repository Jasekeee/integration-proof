// Types, catalog and pure decisions shared by the naive and hardened stores.
import type { OrderRow, OrderStatus, VerificationResult } from "../db/schema";
import { paypalIssues, SANDBOX_API_BASE, type PayPalResponse } from "../paypal/client";
import { capturesOf, PayPalOrderSchema, type Money, type PayPalOrder } from "../paypal/orders";
import type { Transmission, WebhookEvent } from "../paypal/webhooks";

/** The one item the reference store sells. The price is fixed on the server. */
export const PRODUCT: { description: string; amount: Money } = {
  description: "Integration Proof reference item",
  amount: { currency_code: "USD", value: "10.00" },
};

/**
 * Per-call timeout for the store's PayPal requests, the same in both stores. To be set from
 * latency measured on the deployed service (docs/decisions.md, "Timeouts wait for a measurement").
 */
export const PAYPAL_CALL_TIMEOUT_MS = 15_000;

export interface StoreContext {
  /** PayPal sandbox, or the run's fault-injection proxy. */
  baseUrl: string;
  /** Per-call timeout; PAYPAL_CALL_TIMEOUT_MS unless a proof run sets its own. */
  timeoutMs?: number;
}

export const DEFAULT_CONTEXT: StoreContext = { baseUrl: SANDBOX_API_BASE };

export interface CreateOrderInput {
  cartId: string;
  runId?: string | null;
}

export interface CaptureResult {
  status: OrderStatus;
  captureId: string | null;
}

export interface WebhookInput {
  order: OrderRow;
  event: WebhookEvent;
  rawBody: string;
  transmission: Transmission | null;
}

export type WebhookOutcome =
  | "applied"
  | "ignored"
  | "duplicate"
  | "rejected"
  | "verification_unavailable"
  | "reconcile_failed";

export interface WebhookResult {
  httpStatus: number;
  outcome: WebhookOutcome;
  verification: VerificationResult;
}

export interface Store {
  createOrder(input: CreateOrderInput, context: StoreContext): Promise<OrderRow>;
  captureOrder(order: OrderRow, context: StoreContext): Promise<CaptureResult>;
  handleWebhook(input: WebhookInput, context: StoreContext): Promise<WebhookResult>;
}

export class StoreError extends Error {
  constructor(
    message: string,
    readonly httpStatus = 502,
    readonly debugId: string | null = null,
  ) {
    super(message);
    this.name = "StoreError";
  }
}

const CAPTURE_STATUS_TO_ORDER_STATUS = {
  COMPLETED: "PAID",
  PARTIALLY_REFUNDED: "PAID",
  PENDING: "PENDING",
  REFUNDED: "REFUNDED",
  DECLINED: "DECLINED",
  FAILED: "FAILED",
} as const satisfies Record<string, OrderStatus>;

/** The store status PayPal's order implies, or null while the order has no capture. */
export function statusFromPayPal(order: PayPalOrder): CaptureResult | null {
  const capture = capturesOf(order).at(-1);
  if (!capture) return null;
  return { status: CAPTURE_STATUS_TO_ORDER_STATUS[capture.status], captureId: capture.id };
}

const EVENT_TYPE_TO_ORDER_STATUS: Record<string, OrderStatus> = {
  "PAYMENT.CAPTURE.COMPLETED": "PAID",
  "PAYMENT.CAPTURE.PENDING": "PENDING",
  "PAYMENT.CAPTURE.DECLINED": "DECLINED",
  "PAYMENT.CAPTURE.REFUNDED": "REFUNDED",
};

/** The status an event's type suggests, ignoring what PayPal says now. Used by the naive store. */
export function statusFromEventType(eventType: string): OrderStatus | null {
  return EVENT_TYPE_TO_ORDER_STATUS[eventType] ?? null;
}

export type CaptureOutcome =
  /** PayPal answered with the captured order. */
  | { kind: "settled"; result: CaptureResult }
  | { kind: "declined" }
  | { kind: "already_captured" }
  /** A 5xx: PayPal says nothing was done and a retry may succeed. */
  | { kind: "transient" }
  /** No usable answer. PayPal may or may not have captured. */
  | { kind: "unknown" }
  | { kind: "rejected"; issues: string[] };

export function classifyCapture(response: PayPalResponse): CaptureOutcome {
  if (response.kind === "no_response") return { kind: "unknown" };
  if (response.status >= 500) return { kind: "transient" };
  if (response.status >= 200 && response.status < 300) {
    const order = PayPalOrderSchema.safeParse(response.body);
    const result = order.success ? statusFromPayPal(order.data) : null;
    return result ? { kind: "settled", result } : { kind: "unknown" };
  }
  const issues = paypalIssues(response.body);
  if (issues.includes("INSTRUMENT_DECLINED")) return { kind: "declined" };
  if (issues.includes("ORDER_ALREADY_CAPTURED")) return { kind: "already_captured" };
  return { kind: "rejected", issues };
}

/** What a GET order says about the capture: a result, no capture yet, or no answer at all. */
export type Reconciliation = CaptureResult | "not_captured" | "unknown";

export function reconciliationFrom(response: PayPalResponse): Reconciliation {
  if (response.kind === "no_response" || response.status !== 200) return "unknown";
  const order = PayPalOrderSchema.safeParse(response.body);
  if (!order.success) return "unknown";
  return statusFromPayPal(order.data) ?? "not_captured";
}

/** Delay before retry `retry` (1-based): 500 ms, 1 s, 2 s... */
export function backoffMs(retry: number): number {
  return 500 * 2 ** (retry - 1);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Text the buyer sees after a capture attempt. */
export const BUYER_MESSAGES: Record<OrderStatus, string> = {
  CREATED: "Your order is waiting for payment.",
  PENDING: "We are confirming your payment with PayPal.",
  PAID: "Payment received. Thank you for your order.",
  DECLINED: "Your card was declined. Try another card or payment method.",
  FAILED: "Payment failed. Please try again.",
  REFUNDED: "This payment was refunded.",
};
