// Read-only state contract used by the runner: orders of one cart or run, with fulfilments and
// webhook deliveries. This is what the store believes; assertions compare it with PayPal.
import { z } from "zod";
import { errorResponse, invalidRequest, jsonError } from "@/lib/http";
import { StoreModeSchema } from "@/lib/store";
import { readState } from "@/lib/store/repository";

const QuerySchema = z
  .object({
    cartId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
    runId: z.uuid().optional(),
  })
  .refine((query) => query.cartId || query.runId, "Pass cartId or runId.");

export async function GET(request: Request, context: RouteContext<"/api/store/[mode]/state">) {
  const mode = StoreModeSchema.safeParse((await context.params).mode);
  if (!mode.success) return jsonError(404, "unknown_mode", "Store mode must be naive or hardened.");

  const searchParams = new URL(request.url).searchParams;
  const query = QuerySchema.safeParse({
    cartId: searchParams.get("cartId") ?? undefined,
    runId: searchParams.get("runId") ?? undefined,
  });
  if (!query.success) return invalidRequest(query.error.issues);

  try {
    const state = await readState(mode.data, query.data);
    return Response.json({ mode: mode.data, ...state }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
