/**
 * What PayPal answers when the runner repeats one of its own calls, as a retry after a lost
 * response would. The evidence behind "Retries of the runner's own calls" in
 * docs/sandbox-findings.md.
 *
 *   npx tsx scripts/repeated-runner-calls.ts
 *
 * 1. confirm-payment-source twice on one order, without PayPal-Request-Id, which the Orders schema
 *    does not list for that call; then once more after the capture.
 * 2. A refund twice with the same PayPal-Request-Id, then once with a new one.
 *
 * Each order is 1.00 USD, paid with PayPal's published sandbox test card. Credentials come from
 * .env.local; the output shows statuses, issues, ids and debug_ids only.
 */
import { randomUUID } from "node:crypto";
import { paypalIssues, SANDBOX_API_BASE, type PayPalResponse } from "../lib/paypal/client";
import { captureOrder, capturesOf, confirmPaymentSource, createOrder, getOrder, PayPalOrderSchema } from "../lib/paypal/orders";
import { refundCapture } from "../lib/paypal/payments";
import { SANDBOX_TEST_CARD } from "../lib/paypal/test-cards";
import { getAccessToken } from "../lib/paypal/token";

function report(label: string, response: PayPalResponse): unknown {
  if (response.kind === "no_response") {
    console.log(`${label}: no response (${response.reason})`);
    return null;
  }
  const body = response.body as { id?: string; status?: string } | null;
  const order = PayPalOrderSchema.safeParse(response.body).data;
  const captures = order ? ` · captures ${capturesOf(order).map((capture) => capture.status).join(", ") || "none"}` : "";
  const outcome = response.status < 300 ? `${body?.status ?? ""} ${body?.id ?? ""}` : paypalIssues(response.body).join(", ");
  console.log(`${label}: ${response.status} ${outcome}${captures} · debug_id ${response.debugId ?? "none"}`);
  return response.body;
}

async function main(): Promise<void> {
  process.loadEnvFile(".env.local");
  const call = { baseUrl: SANDBOX_API_BASE, token: await getAccessToken(), timeoutMs: 30_000 };
  const amount = { currency_code: "USD", value: "1.00" };

  const newOrder = async (description: string): Promise<string> => {
    const created = report(
      "create order",
      await createOrder(call, { customId: randomUUID(), amount, description, requestId: randomUUID() }),
    );
    return (created as { id: string }).id;
  };

  console.log("1. confirm-payment-source repeated");
  const first = await newOrder("Repeated confirm");
  report("confirm", await confirmPaymentSource(call, { orderId: first, card: SANDBOX_TEST_CARD }));
  report("confirm again", await confirmPaymentSource(call, { orderId: first, card: SANDBOX_TEST_CARD }));
  report("get order", await getOrder(call, first));
  report("capture", await captureOrder(call, { orderId: first, requestId: randomUUID() }));
  report("confirm after the capture", await confirmPaymentSource(call, { orderId: first, card: SANDBOX_TEST_CARD }));

  console.log("2. refund repeated");
  const second = await newOrder("Repeated refund");
  report("confirm", await confirmPaymentSource(call, { orderId: second, card: SANDBOX_TEST_CARD }));
  const captured = PayPalOrderSchema.parse(
    report("capture", await captureOrder(call, { orderId: second, requestId: randomUUID() })),
  );
  const captureId = capturesOf(captured)[0].id;
  const key = randomUUID();
  report("refund with key R", await refundCapture(call, { captureId, requestId: key }));
  report("refund with key R again", await refundCapture(call, { captureId, requestId: key }));
  report("refund with a new key", await refundCapture(call, { captureId, requestId: randomUUID() }));
  report("get order", await getOrder(call, second));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
