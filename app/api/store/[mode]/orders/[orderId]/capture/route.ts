// Capture an order (Orders v2) in the given store mode.
import { z } from "zod";
import { errorResponse, jsonError } from "@/lib/http";
import { stores, StoreModeSchema } from "@/lib/store";
import { findOrder } from "@/lib/store/repository";
import { BUYER_MESSAGES, DEFAULT_CONTEXT } from "@/lib/store/shared";

const PayPalOrderIdSchema = z.string().regex(/^[A-Z0-9]{1,36}$/);

export async function POST(
  _request: Request,
  context: RouteContext<"/api/store/[mode]/orders/[orderId]/capture">,
) {
  const params = await context.params;
  const mode = StoreModeSchema.safeParse(params.mode);
  if (!mode.success) return jsonError(404, "unknown_mode", "Store mode must be naive or hardened.");
  const orderId = PayPalOrderIdSchema.safeParse(params.orderId);
  if (!orderId.success) return jsonError(404, "unknown_order", "No such order in this store.");

  try {
    const order = await findOrder(mode.data, orderId.data);
    if (!order) return jsonError(404, "unknown_order", "No such order in this store.");

    const result = await stores[mode.data].captureOrder(order, DEFAULT_CONTEXT);
    return Response.json({
      orderId: order.paypalOrderId,
      status: result.status,
      captureId: result.captureId,
      message: BUYER_MESSAGES[result.status],
    });
  } catch (error) {
    return errorResponse(error);
  }
}
