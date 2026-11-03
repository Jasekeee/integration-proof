/**
 * One real sandbox purchase through a reference store, as the headless buyer.
 *
 *   npx tsx scripts/checkout.ts --store https://your-service.onrender.com --mode hardened
 *
 * The store creates the order, this script confirms PayPal's published sandbox test card on it,
 * and the store captures. It then polls the store's state until the PAYMENT.CAPTURE.COMPLETED
 * webhook has been recorded, or until --wait seconds pass (default 90, 0 skips waiting).
 * PayPal credentials come from .env.local.
 */
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { SANDBOX_API_BASE } from "../lib/paypal/client";
import { confirmPaymentSource } from "../lib/paypal/orders";
import { SANDBOX_TEST_CARD } from "../lib/paypal/test-cards";
import { getAccessToken } from "../lib/paypal/token";

const CreatedSchema = z.object({ orderId: z.string(), id: z.string(), status: z.string() });
const CapturedSchema = z.object({
  status: z.string(),
  captureId: z.string().nullable(),
  message: z.string(),
});
const StateSchema = z.object({
  orders: z.array(z.object({ status: z.string(), fulfilments: z.number() })),
  deliveries: z.array(
    z.object({ eventType: z.string().nullable(), verification: z.string(), outcome: z.string() }),
  ),
});

async function store(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(120_000),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function main(): Promise<void> {
  process.loadEnvFile(".env.local");
  const { values } = parseArgs({
    options: {
      store: { type: "string", default: "http://localhost:3000" },
      mode: { type: "string", default: "hardened" },
      wait: { type: "string", default: "90" },
    },
  });
  const mode = z.enum(["naive", "hardened"]).parse(values.mode);
  const base = `${new URL(values.store).origin}/api/store/${mode}`;
  const cartId = `cart-${randomUUID()}`;
  console.log(`Store ${base}, cart ${cartId}`);

  const created = await store(`${base}/orders`, { method: "POST", body: JSON.stringify({ cartId }) });
  const order = CreatedSchema.safeParse(created.body);
  if (!order.success) throw new Error(`create failed: HTTP ${created.status} ${JSON.stringify(created.body)}`);
  console.log(`1. store created order ${order.data.orderId} (${order.data.status})`);

  const confirmed = await confirmPaymentSource(
    { baseUrl: SANDBOX_API_BASE, token: await getAccessToken(), timeoutMs: 30_000 },
    { orderId: order.data.orderId, card: SANDBOX_TEST_CARD },
  );
  if (confirmed.kind === "no_response") throw new Error(`confirm got no response: ${confirmed.message}`);
  const approved = z.object({ status: z.literal("APPROVED") }).safeParse(confirmed.body);
  if (!approved.success) throw new Error(`confirm returned HTTP ${confirmed.status}, debug_id ${confirmed.debugId}`);
  console.log(`2. buyer confirmed the test card: APPROVED, debug_id ${confirmed.debugId}`);

  const captured = await store(`${base}/orders/${order.data.orderId}/capture`, { method: "POST" });
  const capture = CapturedSchema.safeParse(captured.body);
  if (!capture.success) throw new Error(`capture failed: HTTP ${captured.status} ${JSON.stringify(captured.body)}`);
  console.log(`3. store captured: ${capture.data.status}, capture ${capture.data.captureId}`);
  console.log(`   buyer sees: "${capture.data.message}"`);

  const deadline = Date.now() + Number(values.wait) * 1000;
  process.stdout.write("4. waiting for PAYMENT.CAPTURE.COMPLETED");
  while (Date.now() < deadline) {
    const read = await store(`${base}/state?cartId=${cartId}`);
    const state = StateSchema.parse(read.body);
    const delivery = state.deliveries.find((item) => item.eventType === "PAYMENT.CAPTURE.COMPLETED");
    if (delivery) {
      console.log(`\n   received: verification ${delivery.verification}, outcome ${delivery.outcome}`);
      console.log(`   order ${state.orders[0]?.status}, fulfilments ${state.orders[0]?.fulfilments}`);
      return;
    }
    process.stdout.write(".");
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  console.log("\n   no webhook recorded yet. Webhooks reach only a public URL registered in PayPal.");
  if (Number(values.wait) > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
