// Orders v2 calls and the slice of the order representation the stores read.
import { z } from "zod";
import { paypalRequest, type PayPalResponse } from "./client";

export const ORDERS_PATH = "/v2/checkout/orders";

export const CaptureStatusSchema = z.enum([
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
]);

export const PayPalOrderSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  purchase_units: z
    .array(
      z.object({
        payments: z
          .object({
            captures: z
              .array(z.object({ id: z.string().min(1), status: CaptureStatusSchema }))
              .optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});

export type PayPalOrder = z.infer<typeof PayPalOrderSchema>;
export type PayPalCapture = NonNullable<
  NonNullable<NonNullable<PayPalOrder["purchase_units"]>[number]["payments"]>["captures"]
>[number];

export function capturesOf(order: PayPalOrder): PayPalCapture[] {
  return (order.purchase_units ?? []).flatMap((unit) => unit.payments?.captures ?? []);
}

export interface Money {
  currency_code: string;
  value: string;
}

interface CallContext {
  baseUrl: string;
  token: string;
  timeoutMs: number;
}

export function createOrder(
  context: CallContext,
  input: { customId: string; amount: Money; description: string; requestId?: string },
): Promise<PayPalResponse> {
  return paypalRequest({
    ...context,
    method: "POST",
    path: ORDERS_PATH,
    requestId: input.requestId,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        { custom_id: input.customId, description: input.description, amount: input.amount },
      ],
    },
  });
}

export function captureOrder(
  context: CallContext,
  input: { orderId: string; requestId?: string },
): Promise<PayPalResponse> {
  return paypalRequest({
    ...context,
    method: "POST",
    path: `${ORDERS_PATH}/${encodeURIComponent(input.orderId)}/capture`,
    requestId: input.requestId,
  });
}

export function getOrder(context: CallContext, orderId: string): Promise<PayPalResponse> {
  return paypalRequest({
    ...context,
    method: "GET",
    path: `${ORDERS_PATH}/${encodeURIComponent(orderId)}`,
  });
}

/** The buyer's step in the headless flow: attach a card so the order becomes APPROVED. */
export function confirmPaymentSource(
  context: CallContext,
  input: { orderId: string; card: Record<string, unknown> },
): Promise<PayPalResponse> {
  return paypalRequest({
    ...context,
    method: "POST",
    path: `${ORDERS_PATH}/${encodeURIComponent(input.orderId)}/confirm-payment-source`,
    body: { payment_source: { card: input.card } },
  });
}
