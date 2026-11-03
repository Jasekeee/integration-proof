// Store logic with each mistake from naive.ts fixed. Read the two side by side.
import { randomUUID } from "node:crypto";
import { captureOrder, createOrder, getOrder } from "../paypal/orders";
import { getAccessToken } from "../paypal/token";
import { verifyWebhookSignature } from "../paypal/webhooks";
import {
  applyEventOnce,
  insertCreatedOrder,
  isEventProcessed,
  saveCaptureResult,
} from "./repository";
import {
  backoffMs,
  classifyCapture,
  PAYPAL_CALL_TIMEOUT_MS,
  PRODUCT,
  reconciliationFrom,
  sleep,
  StoreError,
  type CaptureResult,
  type Store,
  type StoreContext,
} from "./shared";

/** Capture attempts, the first included. Every attempt sends the same PayPal-Request-Id. */
const CAPTURE_ATTEMPTS = 3;

async function paypal(context: StoreContext) {
  return { baseUrl: context.baseUrl, token: await getAccessToken(), timeoutMs: PAYPAL_CALL_TIMEOUT_MS };
}

function webhookId(): string {
  const id = process.env.PAYPAL_WEBHOOK_ID;
  if (!id) throw new StoreError("PAYPAL_WEBHOOK_ID is not set", 500);
  return id;
}

export const hardenedStore: Store = {
  async createOrder(input, context) {
    const id = randomUUID();
    // Fix: one stable PayPal-Request-Id per logical operation.
    const response = await createOrder(await paypal(context), { customId: id, ...PRODUCT, requestId: id });
    return insertCreatedOrder({ id, mode: "hardened", order: input, response, captureRequestId: randomUUID() });
  },

  async captureOrder(order, context) {
    const call = await paypal(context);
    const requestId = order.captureRequestId ?? order.id;
    const save = async (result: CaptureResult) => {
      await saveCaptureResult(order.id, result);
      return result;
    };

    for (let attempt = 1; attempt <= CAPTURE_ATTEMPTS; attempt++) {
      if (attempt > 1) await sleep(backoffMs(attempt - 1));
      // Fix: every attempt carries the same key. If an earlier attempt did capture, PayPal answers
      // the retry with that capture instead of a 422 that reads like a failed payment.
      const outcome = classifyCapture(await captureOrder(call, { orderId: order.paypalOrderId, requestId }));

      if (outcome.kind === "settled") return save(outcome.result);
      if (outcome.kind === "declined") return save({ status: "DECLINED", captureId: null });
      if (outcome.kind === "rejected") return save({ status: "FAILED", captureId: null });
      // Fix: a 5xx is retried with backoff instead of losing the sale.
      if (outcome.kind === "transient") continue;

      // Fix: no answer is not a failure. Ask PayPal what happened before deciding.
      const truth = reconciliationFrom(await getOrder(call, order.paypalOrderId));
      if (truth !== "not_captured" && truth !== "unknown") return save(truth);
    }

    const truth = reconciliationFrom(await getOrder(call, order.paypalOrderId));
    if (truth === "not_captured") return save({ status: "FAILED", captureId: null });
    // PayPal cannot be read: the buyer is told the payment is being confirmed, and the webhook
    // settles the order.
    if (truth === "unknown") return save({ status: "PENDING", captureId: null });
    return save(truth);
  },

  async handleWebhook({ order, event, rawBody, transmission }, context) {
    // Fix: only deliveries PayPal signed are trusted.
    if (!transmission) return { httpStatus: 400, outcome: "rejected", verification: "MISSING_HEADERS" };
    const verification = await verifyWebhookSignature({
      transmission,
      rawBody,
      webhookId: webhookId(),
      token: await getAccessToken(),
    });
    if (verification.status === "FAILURE") {
      return { httpStatus: 400, outcome: "rejected", verification: "FAILURE" };
    }
    if (verification.status === "UNAVAILABLE") {
      // A non-2xx answer makes PayPal deliver the event again later.
      return { httpStatus: 503, outcome: "verification_unavailable", verification: "UNAVAILABLE" };
    }

    // Fix: an event id is applied once.
    if (await isEventProcessed(event.id)) {
      return { httpStatus: 200, outcome: "duplicate", verification: "SUCCESS" };
    }

    // Fix: the order's state comes from PayPal, not from the order in which events arrive.
    const truth = reconciliationFrom(await getOrder(await paypal(context), order.paypalOrderId));
    if (truth === "unknown") return { httpStatus: 503, outcome: "reconcile_failed", verification: "SUCCESS" };

    const result = truth === "not_captured" ? null : truth;
    const applied = await applyEventOnce({
      orderId: order.id,
      eventId: event.id,
      eventType: event.event_type,
      result,
      fulfil: event.event_type === "PAYMENT.CAPTURE.COMPLETED" && result?.status === "PAID",
    });
    return { httpStatus: 200, outcome: applied ? "applied" : "duplicate", verification: "SUCCESS" };
  },
};
