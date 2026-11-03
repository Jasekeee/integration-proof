// Webhook parsing and signature verification by postback to verify-webhook-signature.
import { z } from "zod";
import { paypalRequest, SANDBOX_API_BASE } from "./client";

const VERIFY_PATH = "/v1/notifications/verify-webhook-signature";
const VERIFY_TIMEOUT_MS = 30_000;

/** Request fields of verify-webhook-signature and the delivery headers they are read from. */
export const TRANSMISSION_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

const TransmissionSchema = z.object({
  auth_algo: z.string().min(1).max(100),
  cert_url: z.url().max(500),
  transmission_id: z.string().min(1).max(50),
  transmission_sig: z.string().min(1).max(500),
  transmission_time: z.string().min(1).max(100),
});

export type Transmission = z.infer<typeof TransmissionSchema>;

/** The PayPal transmission headers present on a delivery, keyed by lower-case header name. */
export function pickTransmissionHeaders(headers: Headers): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const name of Object.values(TRANSMISSION_HEADERS)) {
    const value = headers.get(name);
    if (value !== null) picked[name] = value;
  }
  return picked;
}

export function readTransmission(headers: Record<string, string>): Transmission | null {
  const fields = Object.fromEntries(
    Object.entries(TRANSMISSION_HEADERS).map(([field, header]) => [field, headers[header]]),
  );
  return TransmissionSchema.safeParse(fields).data ?? null;
}

/**
 * Embeds the delivered body as is. Re-serialising the parsed event could change the payload PayPal
 * signed, so the event is never round-tripped through JSON.stringify. `rawBody` must be valid JSON.
 */
export function buildVerificationBody(
  transmission: Transmission,
  webhookId: string,
  rawBody: string,
): string {
  const fields = JSON.stringify({ ...transmission, webhook_id: webhookId });
  return `${fields.slice(0, -1)},"webhook_event":${rawBody}}`;
}

const VerificationResponseSchema = z.object({
  verification_status: z.enum(["SUCCESS", "FAILURE"]),
});

export type VerificationStatus = "SUCCESS" | "FAILURE" | "UNAVAILABLE";

export async function verifyWebhookSignature(input: {
  transmission: Transmission;
  rawBody: string;
  webhookId: string;
  token: string;
}): Promise<{ status: VerificationStatus; debugId: string | null }> {
  const response = await paypalRequest({
    baseUrl: SANDBOX_API_BASE,
    method: "POST",
    path: VERIFY_PATH,
    token: input.token,
    rawBody: buildVerificationBody(input.transmission, input.webhookId, input.rawBody),
    timeoutMs: VERIFY_TIMEOUT_MS,
  });
  if (response.kind === "no_response") return { status: "UNAVAILABLE", debugId: null };

  const parsed = VerificationResponseSchema.safeParse(response.body);
  if (response.status !== 200 || !parsed.success) {
    // A malformed request is a failed verification; a PayPal outage is not.
    const status = response.status >= 500 ? "UNAVAILABLE" : "FAILURE";
    return { status, debugId: response.debugId };
  }
  return { status: parsed.data.verification_status, debugId: response.debugId };
}

export const WebhookEventSchema = z.object({
  id: z.string().min(1),
  event_type: z.string().min(1),
  resource_type: z.string().optional(),
  create_time: z.string().optional(),
  resource: z.object({
    id: z.string().optional(),
    status: z.string().optional(),
    custom_id: z.string().optional(),
    supplementary_data: z
      .object({ related_ids: z.object({ order_id: z.string().optional() }).optional() })
      .optional(),
  }),
});

export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

/**
 * Which order an event is about. Order events carry the order itself; capture events carry a
 * capture with the order id in supplementary_data and the store's own id in custom_id.
 */
export function orderReference(event: WebhookEvent): {
  paypalOrderId?: string;
  customId?: string;
} {
  if (event.event_type.startsWith("CHECKOUT.ORDER.")) return { paypalOrderId: event.resource.id };
  return {
    paypalOrderId: event.resource.supplementary_data?.related_ids?.order_id,
    customId: event.resource.custom_id,
  };
}
