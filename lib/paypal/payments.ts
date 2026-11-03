// Payments v2 calls the runner makes as the merchant. Confirmed in docs/sandbox-findings.md.
import { paypalRequest, type PayPalResponse } from "./client";
import type { CallContext } from "./orders";

export const CAPTURES_PATH = "/v2/payments/captures";

/** Refunds a capture in full. The refund inherits the capture's custom_id. */
export function refundCapture(
  context: CallContext,
  input: { captureId: string; requestId: string },
): Promise<PayPalResponse> {
  return paypalRequest({
    ...context,
    method: "POST",
    path: `${CAPTURES_PATH}/${encodeURIComponent(input.captureId)}/refund`,
    requestId: input.requestId,
    body: {},
  });
}
