// Scenario definitions. S3 to S6 are added with the proxy faults and webhook replays they need.
import { z } from "zod";
import { assertS1, assertS2 } from "../assertions";
import type { MockCode, ProxiedOperation } from "../proxy";
import type { Assertion } from "../types";

export const SCENARIO_IDS = ["S1", "S2"] as const;
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
  fault(request: ProxiedRequest): MockCode | null;
  assert: Assertion;
}

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  S1: {
    id: "S1",
    title: "Capture declined",
    summary:
      "PayPal declines the card when the store captures. The store must keep the order unpaid and " +
      "tell the buyer the card was declined, without an error page and without a charge.",
    fault: ({ operation }) => (operation === "capture" ? "INSTRUMENT_DECLINED" : null),
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
      operation === "capture" && captureAttempt === 1 ? "INTERNAL_SERVER_ERROR" : null,
    assert: assertS2,
  },
};
