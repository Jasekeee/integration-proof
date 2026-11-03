// Create an order (Orders v2) in the given store mode.
import { z } from "zod";
import { errorResponse, invalidRequest, jsonError } from "@/lib/http";
import { stores, StoreModeSchema } from "@/lib/store";
import { DEFAULT_CONTEXT } from "@/lib/store/shared";

const BodySchema = z.object({
  cartId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "1-64 letters, digits, '-' or '_'"),
});

export async function POST(request: Request, context: RouteContext<"/api/store/[mode]/orders">) {
  const mode = StoreModeSchema.safeParse((await context.params).mode);
  if (!mode.success) return jsonError(404, "unknown_mode", "Store mode must be naive or hardened.");

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) return invalidRequest(body.error.issues);

  try {
    const order = await stores[mode.data].createOrder({ cartId: body.data.cartId }, DEFAULT_CONTEXT);
    return Response.json(
      {
        orderId: order.paypalOrderId,
        id: order.id,
        mode: order.mode,
        cartId: order.cartId,
        status: order.status,
        amount: { currency_code: order.currencyCode, value: order.amountValue },
      },
      { status: 201 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
