// An in-memory PayPal sandbox for the offline bench. Every behaviour below is one observed in the
// real sandbox and recorded in docs/sandbox-findings.md; the section it comes from is named next to
// it. A request the findings do not cover gets a 501 and is recorded as a violation, so a verdict
// reached on the bench never rests on a guess about PayPal.

export const SANDBOX_ORIGIN = "https://api-m.sandbox.paypal.com";

type OrderStatus = "CREATED" | "APPROVED" | "COMPLETED";
type CaptureStatus = "COMPLETED" | "REFUNDED";

interface Capture {
  id: string;
  status: CaptureStatus;
  /** The PayPal-Request-Id of the capture that created it; a replay with it returns this capture. */
  requestId: string | null;
}

interface Order {
  id: string;
  status: OrderStatus;
  customId: string | null;
  captures: Capture[];
}

interface Refund {
  id: string;
  captureId: string;
  requestId: string;
}

export interface Delivery {
  headers: Record<string, string>;
  body: string;
}

interface SentDelivery extends Delivery {
  transmissionId: string;
  signature: string;
}

const MOCK_HEADER = "paypal-mock-response";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": "bench" },
  });
}

function issue(status: number, name: string, code: string): Response {
  return json(status, { name, details: [{ issue: code }] });
}

export class PayPalModel {
  /** Requests outside the observed behaviour. A run with any is not a valid verification. */
  readonly violations: string[] = [];
  private readonly orders = new Map<string, Order>();
  private readonly refunds: Refund[] = [];
  private readonly pending: Delivery[] = [];
  private readonly sent: SentDelivery[] = [];
  private counter = 0;

  constructor(private readonly webhookId: string) {}

  /** Deliveries PayPal has not sent yet, oldest first. Taking them marks them sent. */
  takeDeliveries(): Delivery[] {
    return this.pending.splice(0);
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const route = `${request.method} ${path}`;

    // OAuth token: a client-credentials grant returns a bearer token.
    if (route === "POST /v1/oauth2/token") {
      if (!request.headers.get("authorization")?.startsWith("Basic ")) return this.refuse(route, "no client credentials");
      return json(200, { access_token: "bench-token", token_type: "Bearer", expires_in: 32_400 });
    }
    // Latency and connection failures: a call without a token is refused with 401.
    if (request.headers.get("authorization") !== "Bearer bench-token") {
      return json(401, { error: "invalid_token" });
    }

    const body = request.method === "POST" ? await request.text() : "";
    let match: RegExpExecArray | null;
    if (route === "POST /v2/checkout/orders") return this.createOrder(body);
    if ((match = /^GET \/v2\/checkout\/orders\/([A-Z0-9]+)$/.exec(route))) return this.getOrder(match[1]);
    if ((match = /^POST \/v2\/checkout\/orders\/([A-Z0-9]+)\/confirm-payment-source$/.exec(route))) {
      return this.confirm(match[1], body);
    }
    if ((match = /^POST \/v2\/checkout\/orders\/([A-Z0-9]+)\/capture$/.exec(route))) {
      return this.capture(match[1], request.headers);
    }
    if ((match = /^POST \/v2\/payments\/captures\/([A-Z0-9]+)\/refund$/.exec(route))) {
      return this.refund(match[1], body, request.headers.get("paypal-request-id"));
    }
    if (route === "POST /v1/notifications/verify-webhook-signature") return this.verify(body);
    return this.refuse(route, "not observed in the sandbox");
  }

  private refuse(route: string, reason: string): Response {
    this.violations.push(`${route}: ${reason}`);
    return json(501, { name: "NOT_MODELED", message: `The bench does not model this call: ${reason}.` });
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}${String(this.counter).padStart(16, "0")}`;
  }

  private representation(order: Order) {
    return {
      id: order.id,
      status: order.status,
      purchase_units: [
        {
          ...(order.customId ? { custom_id: order.customId } : {}),
          ...(order.captures.length > 0
            ? { payments: { captures: order.captures.map(({ id, status }) => ({ id, status })) } }
            : {}),
        },
      ],
    };
  }

  /** Headless card purchase: a bare intent CAPTURE order is created as CREATED. */
  private createOrder(body: string): Response {
    const parsed = parse(body) as { intent?: string; purchase_units?: { custom_id?: string }[] } | null;
    if (parsed?.intent !== "CAPTURE") return this.refuse("POST /v2/checkout/orders", "only intent CAPTURE was observed");
    const order: Order = {
      id: this.nextId("O"),
      status: "CREATED",
      customId: parsed.purchase_units?.[0]?.custom_id ?? null,
      captures: [],
    };
    this.orders.set(order.id, order);
    return json(201, this.representation(order));
  }

  /** Mocked decline, Full refund of a capture: GET returns the order and its captures as they are. */
  private getOrder(orderId: string): Response {
    const order = this.orders.get(orderId);
    if (!order) return this.refuse(`GET /v2/checkout/orders/${orderId}`, "unknown order");
    return json(200, this.representation(order));
  }

  /**
   * Headless card purchase: a card on confirm-payment-source approves the order. confirm-payment-source
   * repeated: confirming an APPROVED order again returns APPROVED; after the capture it is a 422.
   */
  private confirm(orderId: string, body: string): Response {
    const route = `POST /v2/checkout/orders/${orderId}/confirm-payment-source`;
    const order = this.orders.get(orderId);
    if (!order) return this.refuse(route, "unknown order");
    const parsed = parse(body) as { payment_source?: { card?: unknown } } | null;
    if (!parsed?.payment_source?.card) return this.refuse(route, "only a card payment source was observed");
    if (order.status === "COMPLETED") return issue(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED");
    order.status = "APPROVED";
    return json(200, { id: order.id, status: order.status });
  }

  /**
   * Mocked decline on capture, Retry after a mocked 500, Capture replay and repeated capture, A real
   * delivery on the deployed service.
   */
  private capture(orderId: string, headers: Headers): Response {
    const route = `POST /v2/checkout/orders/${orderId}/capture`;
    const order = this.orders.get(orderId);
    if (!order) return this.refuse(route, "unknown order");
    const requestId = headers.get("paypal-request-id");

    const mock = headers.get(MOCK_HEADER);
    if (mock !== null) {
      const code = (parse(mock) as { mock_application_codes?: string } | null)?.mock_application_codes;
      if (order.status !== "APPROVED") return this.refuse(route, "a mock was observed on an APPROVED order only");
      // The decline leaves the order APPROVED and captures nothing.
      if (code === "INSTRUMENT_DECLINED") return issue(422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED");
      // The mocked 500 captures nothing and is not stored against the key.
      if (code === "INTERNAL_SERVER_ERROR") return issue(500, "INTERNAL_SERVER_ERROR", "INTERNAL_SERVER_ERROR");
      return this.refuse(route, `mock ${code} was not observed`);
    }

    if (order.status === "COMPLETED") {
      const original = order.captures[0];
      // The same key returns the original capture with 200; a new key or none is refused.
      if (requestId !== null && requestId === original.requestId) return json(200, this.representation(order));
      return issue(422, "UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED");
    }
    if (order.status !== "APPROVED") return this.refuse(route, "capture of an order that is not APPROVED");

    const capture: Capture = { id: this.nextId("C"), status: "COMPLETED", requestId };
    order.captures.push(capture);
    order.status = "COMPLETED";
    // The capture carries custom_id and the order id in supplementary_data.
    this.queue("PAYMENT.CAPTURE.COMPLETED", "capture", {
      id: capture.id,
      status: "COMPLETED",
      ...(order.customId ? { custom_id: order.customId } : {}),
      supplementary_data: { related_ids: { order_id: order.id } },
    });
    return json(201, this.representation(order));
  }

  /**
   * Full refund of a capture: an empty body refunds the full amount; the order stays COMPLETED and
   * the capture becomes REFUNDED. Refund repeated with the same key: 200 and the same refund; a new
   * key is a 422.
   */
  private refund(captureId: string, body: string, requestId: string | null): Response {
    const route = `POST /v2/payments/captures/${captureId}/refund`;
    const order = [...this.orders.values()].find((candidate) => candidate.captures.some((c) => c.id === captureId));
    const capture = order?.captures.find((candidate) => candidate.id === captureId);
    if (!order || !capture) return this.refuse(route, "unknown capture");
    if (requestId === null) return this.refuse(route, "a refund without PayPal-Request-Id was not observed");
    const parsed = parse(body === "" ? "{}" : body);
    if (!parsed || typeof parsed !== "object" || Object.keys(parsed).length > 0) {
      return this.refuse(route, "only a full refund with an empty body was observed");
    }

    const replay = this.refunds.find((refund) => refund.captureId === captureId && refund.requestId === requestId);
    if (replay) return json(200, { id: replay.id, status: "COMPLETED" });
    if (capture.status === "REFUNDED") return issue(422, "UNPROCESSABLE_ENTITY", "CAPTURE_FULLY_REFUNDED");

    const refund: Refund = { id: this.nextId("R"), captureId, requestId };
    this.refunds.push(refund);
    capture.status = "REFUNDED";
    // Deliveries around the refund: the refund resource has custom_id but no supplementary_data.
    this.queue("PAYMENT.CAPTURE.REFUNDED", "refund", {
      id: refund.id,
      status: "COMPLETED",
      ...(order.customId ? { custom_id: order.customId } : {}),
    });
    return json(201, { id: refund.id, status: "COMPLETED" });
  }

  /**
   * A webhook event, sent later. Deliveries around the refund: events reach the store after the
   * calls that caused them, in the order PayPal created them.
   */
  private queue(eventType: string, resourceType: string, resource: Record<string, unknown>): void {
    const transmissionId = `bench-transmission-${this.counter + 1}`;
    const signature = `bench-signature-${this.counter + 1}`;
    const event = {
      id: this.nextId("WH-"),
      event_type: eventType,
      resource_type: resourceType,
      resource_version: "2.0",
      resource,
    };
    const delivery: SentDelivery = {
      transmissionId,
      signature,
      body: JSON.stringify(event),
      headers: {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": `${SANDBOX_ORIGIN}/v1/notifications/certs/CERT-bench`,
        "paypal-transmission-id": transmissionId,
        "paypal-transmission-sig": signature,
        "paypal-transmission-time": "2026-11-04T12:00:00Z",
      },
    };
    this.sent.push(delivery);
    this.pending.push({ headers: delivery.headers, body: delivery.body });
  }

  /**
   * Replay of a recorded delivery: the same body with its transmission headers verifies, however
   * often it is sent. Verification of a forged signature: anything PayPal did not send fails, with
   * a 200 answer. A body changed after signing: fails as well.
   */
  private verify(body: string): Response {
    const request = parse(body) as {
      transmission_id?: string;
      transmission_sig?: string;
      webhook_id?: string;
      webhook_event?: unknown;
    } | null;
    if (!request) return this.refuse("POST /v1/notifications/verify-webhook-signature", "a body that is not JSON");
    const original = this.sent.find((delivery) => delivery.transmissionId === request.transmission_id);
    const genuine =
      original !== undefined &&
      request.transmission_sig === original.signature &&
      request.webhook_id === this.webhookId &&
      JSON.stringify(request.webhook_event) === JSON.stringify(parse(original.body));
    return json(200, { verification_status: genuine ? "SUCCESS" : "FAILURE" });
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
