import { describe, expect, it } from "vitest";
import {
  buildVerificationBody,
  orderReference,
  readTransmission,
  WebhookEventSchema,
  type Transmission,
} from "./webhooks";

const TRANSMISSION: Transmission = {
  auth_algo: "SHA256withRSA",
  cert_url: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-a5cafa77",
  transmission_id: "103e3700-8b0c-11e6-8695-6b62a8a99ac4",
  transmission_sig: "t8hlRk64rpEImZMKqgtp5dlWaT1W8ed",
  transmission_time: "2026-11-03T10:00:00Z",
};

const HEADERS = {
  "paypal-auth-algo": TRANSMISSION.auth_algo,
  "paypal-cert-url": TRANSMISSION.cert_url,
  "paypal-transmission-id": TRANSMISSION.transmission_id,
  "paypal-transmission-sig": TRANSMISSION.transmission_sig,
  "paypal-transmission-time": TRANSMISSION.transmission_time,
};

describe("buildVerificationBody", () => {
  it("embeds the delivered body byte for byte", () => {
    // Formatting a parser would normalise: spacing and a trailing zero on the amount.
    const rawBody = '{"id":"WH-1",  "resource":{"amount":{"value":"10.00"},"n":1.50}}';
    const body = buildVerificationBody(TRANSMISSION, "8PT597110X687430LKGECATA", rawBody);

    expect(body.endsWith(`"webhook_event":${rawBody}}`)).toBe(true);
    expect(JSON.parse(body)).toEqual({
      ...TRANSMISSION,
      webhook_id: "8PT597110X687430LKGECATA",
      webhook_event: JSON.parse(rawBody),
    });
  });
});

describe("readTransmission", () => {
  it("reads all five transmission headers", () => {
    expect(readTransmission(HEADERS)).toEqual(TRANSMISSION);
  });

  it("returns null when a header is missing", () => {
    const unsigned: Record<string, string> = { ...HEADERS };
    delete unsigned["paypal-transmission-sig"];
    expect(readTransmission(unsigned)).toBeNull();
  });
});

describe("orderReference", () => {
  it("reads the order id of a capture event from supplementary_data and custom_id", () => {
    const event = WebhookEventSchema.parse({
      id: "WH-2",
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: {
        id: "CAP1",
        custom_id: "0b6f3c1e-7d51-4f0c-9a3b-3f2d8c1e5a90",
        supplementary_data: { related_ids: { order_id: "5O190127TN364715T" } },
      },
    });
    expect(orderReference(event)).toEqual({
      paypalOrderId: "5O190127TN364715T",
      customId: "0b6f3c1e-7d51-4f0c-9a3b-3f2d8c1e5a90",
    });
  });

  it("reads the order id of an order event from the resource itself", () => {
    const event = WebhookEventSchema.parse({
      id: "WH-3",
      event_type: "CHECKOUT.ORDER.APPROVED",
      resource: { id: "5O190127TN364715T" },
    });
    expect(orderReference(event)).toEqual({ paypalOrderId: "5O190127TN364715T" });
  });
});
