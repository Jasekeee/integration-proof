// Scenario definitions, one per row of the Scenarios table in CLAUDE.md.
import { z } from "zod";
import { assertS1, assertS2, assertS3, assertS4, assertS5, assertS6 } from "../assertions";
import type { Fault, ProxiedOperation } from "../proxy";
import type { Assertion } from "../types";

export const SCENARIO_IDS = ["S1", "S2", "S3", "S4", "S5", "S6"] as const;
export type ScenarioId = (typeof SCENARIO_IDS)[number];
export const ScenarioIdSchema = z.enum(SCENARIO_IDS);

/** A request the store sent through the proxy. captureAttempt counts captures in this scenario. */
export interface ProxiedRequest {
  operation: ProxiedOperation;
  captureAttempt: number;
}

export interface Scenario {
  id: ScenarioId;
  title: string;
  /** What happens and what a correct store does, in product language. */
  summary: string;
  /** The fault the proxy injects into one request, or null to forward it untouched. */
  fault(request: ProxiedRequest): Fault | null;
  /** The buyer checks out the same cart again when the store says the payment failed. */
  buyerRetriesFailedPayment?: boolean;
  /** The merchant refunds the capture right after it, through the Payments API. */
  refundAfterCapture?: boolean;
  /** What the runner sends the webhook router once PayPal's own deliveries have arrived. */
  delivery?: "replay" | "forge";
  /** Without PayPal's webhooks there is nothing to replay or forge, so the scenario cannot judge. */
  needsWebhooks?: boolean;
  assert: Assertion;
}

const none = () => null;

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  S1: {
    id: "S1",
    title: "Capture declined",
    summary:
      "PayPal declines the card when the store captures. The store must keep the order unpaid and " +
      "tell the buyer the card was declined, without an error page and without a charge.",
    fault: ({ operation }) => (operation === "capture" ? { kind: "mock", code: "INSTRUMENT_DECLINED" } : null),
    assert: assertS1,
  },
  S2: {
    id: "S2",
    title: "Transient 5xx on capture",
    summary:
      "PayPal answers the first capture attempt with a 500 and captures nothing. A store that treats " +
      "the 500 as final loses a sale from a buyer who was ready to pay; a store that retries captures " +
      "the order once.",
    fault: ({ operation, captureAttempt }) =>
      operation === "capture" && captureAttempt === 1 ? { kind: "mock", code: "INTERNAL_SERVER_ERROR" } : null,
    assert: assertS2,
  },
  S3: {
    id: "S3",
    title: "Lost response after successful capture",
    summary:
      "PayPal captures the payment, but its answer reaches the store after the store has stopped " +
      "waiting. A store that reads the timeout as a failed payment sends the buyer back to checkout, " +
      "and the second order is charged too. A store that asks PayPal sees the capture and marks the " +
      "order paid.",
    fault: ({ operation, captureAttempt }) =>
      operation === "capture" && captureAttempt === 1 ? { kind: "hold_response" } : null,
    buyerRetriesFailedPayment: true,
    assert: assertS3,
  },
  S4: {
    id: "S4",
    title: "Duplicate webhook",
    summary:
      "The same real PAYMENT.CAPTURE.COMPLETED arrives twice, with a valid signature both times. " +
      "The order must be fulfilled once.",
    fault: none,
    delivery: "replay",
    needsWebhooks: true,
    assert: assertS4,
  },
  S5: {
    id: "S5",
    title: "Out-of-order webhooks",
    summary:
      "The merchant refunds the payment right after the capture, and a PAYMENT.CAPTURE.COMPLETED " +
      "arrives after the refund. A store that applies events in arrival order ends up paid; a store " +
      "that asks PayPal ends up refunded, as PayPal reports.",
    fault: none,
    refundAfterCapture: true,
    delivery: "replay",
    needsWebhooks: true,
    assert: assertS5,
  },
  S6: {
    id: "S6",
    title: "Forged webhook",
    summary:
      "A delivery arrives with PayPal's transmission headers but a body changed after signing. The " +
      "store must reject it with a 4xx and leave the order as it was.",
    fault: none,
    delivery: "forge",
    needsWebhooks: true,
    assert: assertS6,
  },
};
