/**
 * Does a recorded webhook delivery still pass signature verification when it is sent again?
 *
 *   npx tsx scripts/webhook-replay.ts [--event-id WH-...] [--post https://your-service.onrender.com]
 *
 * Loads a recorded delivery (the latest PAYMENT.CAPTURE.COMPLETED by default) with its original
 * transmission headers and body, and asks verify-webhook-signature about it again. With --post it
 * also delivers the same bytes and headers to the webhook router. Credentials and DATABASE_URL
 * come from .env.local.
 */
import { parseArgs } from "node:util";
import { desc, eq } from "drizzle-orm";
import { getDb } from "../lib/db/client";
import { webhookDeliveries } from "../lib/db/schema";
import { readTransmission, verifyWebhookSignature } from "../lib/paypal/webhooks";
import { getAccessToken } from "../lib/paypal/token";

async function main(): Promise<void> {
  process.loadEnvFile(".env.local");
  const { values } = parseArgs({
    options: { "event-id": { type: "string" }, post: { type: "string" } },
  });
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) throw new Error("PAYPAL_WEBHOOK_ID is not set in .env.local");

  const db = getDb();
  try {
    const [delivery] = await db
      .select()
      .from(webhookDeliveries)
      .where(
        values["event-id"]
          ? eq(webhookDeliveries.eventId, values["event-id"])
          : eq(webhookDeliveries.eventType, "PAYMENT.CAPTURE.COMPLETED"),
      )
      .orderBy(desc(webhookDeliveries.receivedAt))
      .limit(1);
    if (!delivery) throw new Error("no recorded delivery matches");

    console.log(`Delivery of ${delivery.eventId} (${delivery.eventType})`);
    console.log(`  received ${delivery.receivedAt.toISOString()}, recorded verification ${delivery.verification}`);
    console.log(`  transmission time ${delivery.headers["paypal-transmission-time"] ?? "missing"}`);

    const transmission = readTransmission(delivery.headers);
    if (!transmission) throw new Error("the delivery has no complete set of transmission headers");

    const verdict = await verifyWebhookSignature({
      transmission,
      rawBody: delivery.body,
      webhookId,
      token: await getAccessToken(),
    });
    console.log(`Verification of the replay: ${verdict.status}, debug_id ${verdict.debugId ?? "none"}`);

    if (values.post) {
      const url = `${new URL(values.post).origin}/api/store/webhooks-router`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...delivery.headers },
        body: delivery.body,
        signal: AbortSignal.timeout(60_000),
      });
      console.log(`Router answered HTTP ${response.status}: ${await response.text()}`);
    }
  } finally {
    await db.$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
