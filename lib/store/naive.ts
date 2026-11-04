// Store logic with the common integration mistakes left in. Read it side by side with hardened.ts.
import { randomUUID } from "node:crypto";
import { captureOrder, createOrder } from "../paypal/orders";
import { getAccessToken } from "../paypal/token";
import {
  insertCreatedOrder,
  recordFulfilment,
  saveCaptureResult,
  setOrderStatus,
} from "./repository";
import {
  classifyCapture,
  PAYPAL_CALL_TIMEOUT_MS,
  PRODUCT,
  statusFromEventType,
  type CaptureResult,
  type Store,
  type StoreContext,
} from "./shared";

async function paypal(context: StoreContext) {
  const timeoutMs = context.timeoutMs ?? PAYPAL_CALL_TIMEOUT_MS;
  return { baseUrl: context.baseUrl, token: await getAccessToken(), timeoutMs };
}

export const naiveStore: Store = {
  async createOrder(input, context) {
    const id = randomUUID();
    // Mistake: no PayPal-Request-Id.
    const response = await createOrder(await paypal(context), { customId: id, ...PRODUCT });
    return insertCreatedOrder({ id, mode: "naive", order: input, response, captureRequestId: null });
  },

  async captureOrder(order, context) {
    // Mistakes: no PayPal-Request-Id, a 5xx is final, and a timeout is read as a failed payment
    // without asking PayPal whether the capture went through.
    const outcome = classifyCapture(
      await captureOrder(await paypal(context), { orderId: order.paypalOrderId }),
    );

    // [S1] A decline is recorded as DECLINED and the buyer is told so.
    let result: CaptureResult;
    if (outcome.kind === "settled") result = outcome.result;
    else if (outcome.kind === "declined") result = { status: "DECLINED", captureId: null };
    else result = { status: "FAILED", captureId: null };

    await saveCaptureResult(order.id, result);
    return result;
  },

  async handleWebhook({ order, event }) {
    // Mistakes: no signature verification, no event-id dedupe, and each event's status is applied
    // in the order deliveries arrive.
    const status = statusFromEventType(event.event_type);
    if (!status) return { httpStatus: 200, outcome: "ignored", verification: "NOT_CHECKED" };

    await setOrderStatus(order.id, status);
    if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") await recordFulfilment(order.id, event.id);
    return { httpStatus: 200, outcome: "applied", verification: "NOT_CHECKED" };
  },
};
