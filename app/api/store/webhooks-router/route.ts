// Single registered webhook. Finds the order an event is about and hands the delivery to the store
// that owns it (order.mode). Every delivery is recorded byte for byte, whatever the outcome.
import { errorResponse, jsonError } from "@/lib/http";
import {
  orderReference,
  pickTransmissionHeaders,
  readTransmission,
  WebhookEventSchema,
} from "@/lib/paypal/webhooks";
import { stores } from "@/lib/store";
import { findOrderForEvent, recordDelivery } from "@/lib/store/repository";
import { DEFAULT_CONTEXT } from "@/lib/store/shared";

/** PayPal events are a few kilobytes; anything far larger is not one. */
const MAX_BODY_BYTES = 256 * 1024;

type Delivery = Parameters<typeof recordDelivery>[0];

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) {
    return jsonError(413, "payload_too_large", "Webhook body is too large.");
  }

  const delivery: Delivery = {
    headers: pickTransmissionHeaders(request.headers),
    body: rawBody,
    verification: "NOT_CHECKED",
    outcome: "error",
    responseStatus: 500,
  };

  let response: Response;
  try {
    response = await dispatch(rawBody, delivery);
  } catch (error) {
    response = errorResponse(error);
  }

  delivery.responseStatus = response.status;
  try {
    await recordDelivery(delivery);
  } catch (error) {
    console.error("Could not record a webhook delivery", error);
  }
  return response;
}

/** Routes one delivery and fills in what is learned about it along the way. */
async function dispatch(rawBody: string, delivery: Delivery): Promise<Response> {
  const event = WebhookEventSchema.safeParse(parseJson(rawBody));
  if (!event.success) {
    delivery.outcome = "malformed";
    return jsonError(400, "malformed_event", "Body is not a PayPal webhook event.");
  }
  delivery.eventId = event.data.id;
  delivery.eventType = event.data.event_type;

  const order = await findOrderForEvent(orderReference(event.data));
  if (!order) {
    // Acknowledged so PayPal stops redelivering events for orders these stores never created.
    delivery.outcome = "unknown_order";
    return Response.json({ outcome: "unknown_order" });
  }
  delivery.mode = order.mode;
  delivery.orderId = order.id;

  const result = await stores[order.mode].handleWebhook(
    { order, event: event.data, rawBody, transmission: readTransmission(delivery.headers) },
    DEFAULT_CONTEXT,
  );
  delivery.verification = result.verification;
  delivery.outcome = result.outcome;
  return Response.json(
    { outcome: result.outcome, verification: result.verification },
    { status: result.httpStatus },
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
