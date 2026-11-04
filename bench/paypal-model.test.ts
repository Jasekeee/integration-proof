// The model against the sandbox behaviour it is built from, one fact of docs/sandbox-findings.md per test.
import { describe, expect, it } from "vitest";
import { PayPalModel, SANDBOX_ORIGIN } from "./paypal-model";

const TOKEN = { authorization: "Bearer bench-token", "content-type": "application/json" };

function model() {
  const paypal = new PayPalModel("WH-TEST");
  const call = async (method: string, path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) => {
    const response = await paypal.handle(
      new Request(`${SANDBOX_ORIGIN}${path}`, {
        method,
        headers: { ...TOKEN, ...options.headers },
        body: options.body === undefined ? undefined : typeof options.body === "string" ? options.body : JSON.stringify(options.body),
      }),
    );
    const body = await response.json();
    const issues = (body.details ?? []).map((detail: { issue: string }) => detail.issue);
    return { status: response.status, body, issues };
  };
  const approvedOrder = async () => {
    const created = await call("POST", "/v2/checkout/orders", {
      body: { intent: "CAPTURE", purchase_units: [{ custom_id: "3f1c2b9e-8d4a-4c1e-9f2b-6a7d8e9f0a1b" }] },
    });
    await call("POST", `/v2/checkout/orders/${created.body.id}/confirm-payment-source`, { body: { payment_source: { card: {} } } });
    return created.body.id as string;
  };
  const capture = (orderId: string, headers: Record<string, string> = {}) =>
    call("POST", `/v2/checkout/orders/${orderId}/capture`, { headers });
  return { paypal, call, approvedOrder, capture };
}

describe("PayPal model", () => {
  it("issues a token for client credentials and refuses a call without one (OAuth token)", async () => {
    const paypal = new PayPalModel("WH-TEST");
    const token = await paypal.handle(
      new Request(`${SANDBOX_ORIGIN}/v1/oauth2/token`, { method: "POST", headers: { authorization: "Basic eA==" }, body: "grant_type=client_credentials" }),
    );
    expect(token.status).toBe(200);
    const unauthenticated = await paypal.handle(new Request(`${SANDBOX_ORIGIN}/v2/checkout/orders/X`));
    expect(unauthenticated.status).toBe(401);
  });

  it("creates CREATED, approves with a card, and approves again on a repeated confirm (Headless card purchase)", async () => {
    const { call } = model();
    const created = await call("POST", "/v2/checkout/orders", { body: { intent: "CAPTURE", purchase_units: [{}] } });
    expect(created).toMatchObject({ status: 201, body: { status: "CREATED" } });
    const confirm = () =>
      call("POST", `/v2/checkout/orders/${created.body.id}/confirm-payment-source`, { body: { payment_source: { card: {} } } });
    expect(await confirm()).toMatchObject({ status: 200, body: { status: "APPROVED" } });
    expect(await confirm()).toMatchObject({ status: 200, body: { status: "APPROVED" } });
  });

  it("declines with a mock and leaves the order APPROVED with no capture (Mocked decline on capture)", async () => {
    const { call, approvedOrder, capture } = model();
    const orderId = await approvedOrder();
    const declined = await capture(orderId, { "paypal-mock-response": JSON.stringify({ mock_application_codes: "INSTRUMENT_DECLINED" }) });
    expect(declined).toMatchObject({ status: 422, issues: ["INSTRUMENT_DECLINED"] });
    const order = await call("GET", `/v2/checkout/orders/${orderId}`);
    expect(order.body.status).toBe("APPROVED");
    expect(order.body.purchase_units[0].payments).toBeUndefined();
  });

  it("does not store a mocked 500 against the key, so the retry captures (Retry after a mocked 500)", async () => {
    const { approvedOrder, capture } = model();
    const orderId = await approvedOrder();
    const mock = { "paypal-mock-response": JSON.stringify({ mock_application_codes: "INTERNAL_SERVER_ERROR" }) };
    expect(await capture(orderId, { ...mock, "paypal-request-id": "B" })).toMatchObject({ status: 500 });
    expect(await capture(orderId, { "paypal-request-id": "B" })).toMatchObject({ status: 201, body: { status: "COMPLETED" } });
  });

  it("answers the same key with the original capture and refuses a second capture (Capture replay)", async () => {
    const { approvedOrder, capture } = model();
    const orderId = await approvedOrder();
    const first = await capture(orderId, { "paypal-request-id": "A" });
    const replay = await capture(orderId, { "paypal-request-id": "A" });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body.purchase_units[0].payments.captures).toEqual(first.body.purchase_units[0].payments.captures);
    expect(await capture(orderId, { "paypal-request-id": "new" })).toMatchObject({ status: 422, issues: ["ORDER_ALREADY_CAPTURED"] });
    expect(await capture(orderId)).toMatchObject({ status: 422, issues: ["ORDER_ALREADY_CAPTURED"] });
  });

  it("refunds once per key and keeps the order COMPLETED with the capture REFUNDED (Refunds)", async () => {
    const { call, approvedOrder, capture } = model();
    const orderId = await approvedOrder();
    const captureId = (await capture(orderId, { "paypal-request-id": "A" })).body.purchase_units[0].payments.captures[0].id;
    const refund = (key: string) => call("POST", `/v2/payments/captures/${captureId}/refund`, { body: {}, headers: { "paypal-request-id": key } });
    const first = await refund("R");
    expect(first).toMatchObject({ status: 201, body: { status: "COMPLETED" } });
    expect(await refund("R")).toMatchObject({ status: 200, body: { id: first.body.id } });
    expect(await refund("other")).toMatchObject({ status: 422, issues: ["CAPTURE_FULLY_REFUNDED"] });
    const order = await call("GET", `/v2/checkout/orders/${orderId}`);
    expect(order.body.status).toBe("COMPLETED");
    expect(order.body.purchase_units[0].payments.captures[0].status).toBe("REFUNDED");
  });

  it("sends COMPLETED and then REFUNDED, each verifiable as sent and on replay, and not once changed", async () => {
    const { paypal, call, approvedOrder, capture } = model();
    const orderId = await approvedOrder();
    const captureId = (await capture(orderId, { "paypal-request-id": "A" })).body.purchase_units[0].payments.captures[0].id;
    await call("POST", `/v2/payments/captures/${captureId}/refund`, { body: {}, headers: { "paypal-request-id": "R" } });
    const [completed, refunded] = paypal.takeDeliveries();
    expect(JSON.parse(completed.body)).toMatchObject({
      event_type: "PAYMENT.CAPTURE.COMPLETED",
      resource: { id: captureId, supplementary_data: { related_ids: { order_id: orderId } } },
    });
    expect(JSON.parse(refunded.body).event_type).toBe("PAYMENT.CAPTURE.REFUNDED");
    expect(JSON.parse(refunded.body).resource.supplementary_data).toBeUndefined();
    expect(paypal.takeDeliveries()).toEqual([]);

    const verify = (headers: Record<string, string>, body: string, webhookId = "WH-TEST") =>
      call("POST", "/v1/notifications/verify-webhook-signature", {
        body: `{"auth_algo":"${headers["paypal-auth-algo"]}","cert_url":"${headers["paypal-cert-url"]}","transmission_id":"${headers["paypal-transmission-id"]}","transmission_sig":"${headers["paypal-transmission-sig"]}","transmission_time":"${headers["paypal-transmission-time"]}","webhook_id":"${webhookId}","webhook_event":${body}}`,
      });
    expect((await verify(completed.headers, completed.body)).body.verification_status).toBe("SUCCESS");
    expect((await verify(completed.headers, completed.body)).body.verification_status).toBe("SUCCESS");
    const forged = completed.body.replace("PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED");
    expect(await verify(completed.headers, forged)).toMatchObject({ status: 200, body: { verification_status: "FAILURE" } });
    expect((await verify(completed.headers, completed.body, "WH-OTHER")).body.verification_status).toBe("FAILURE");
  });

  it("refuses and records every call the findings do not cover", async () => {
    const { paypal, call, approvedOrder } = model();
    expect((await call("POST", "/v2/checkout/orders", { body: { intent: "AUTHORIZE" } })).status).toBe(501);
    const orderId = await approvedOrder();
    expect((await call("POST", `/v2/checkout/orders/${orderId}/authorize`)).status).toBe(501);
    expect(paypal.violations).toHaveLength(2);
  });
});
