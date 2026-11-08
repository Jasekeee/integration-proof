// A small store for the CLI's tests, written from the contract (docs/store-contract.md), not from
// lib/store. Its two capture mistakes can be switched on one at a time, so a test can show that each
// scenario catches the mistake it is about and passes a store without it.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureOptions {
  /** Where the store sends every PayPal call, the OAuth token included: the CLI's proxy. */
  paypalBase: string;
  /** A 5xx on capture is retried with the same PayPal-Request-Id (S2). */
  retriesTransientErrors: boolean;
  /** A capture without an answer is settled by asking PayPal for the order (S3). */
  asksPayPalAfterTimeout: boolean;
  /** The store's PayPal timeout in ms; null waits for as long as PayPal takes. */
  timeoutMs: number | null;
}

type Status = "CREATED" | "PENDING" | "PAID" | "DECLINED" | "FAILED" | "REFUNDED";
interface Order {
  paypalOrderId: string;
  cartId: string;
  status: Status;
  fulfilments: number;
}

const MESSAGES: Record<Status, string> = {
  CREATED: "Your order is created.",
  PENDING: "Your payment is pending.",
  PAID: "Payment received. Thank you for your order.",
  DECLINED: "Your card was declined. Try another card or payment method.",
  FAILED: "Payment failed. Please try again.",
  REFUNDED: "Your payment was refunded.",
};

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

export async function startFixtureStore(options: FixtureOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const orders = new Map<string, Order>();

  async function paypal(method: string, path: string, init: { body?: unknown; requestId?: string } = {}) {
    const token = (await (
      await fetch(`${options.paypalBase}/v1/oauth2/token`, {
        method: "POST",
        headers: { authorization: `Basic ${Buffer.from("fixture:fixture").toString("base64")}`, "content-type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      })
    ).json()) as { access_token: string };
    const response = await fetch(`${options.paypalBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json",
        ...(init.requestId ? { "paypal-request-id": init.requestId } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: options.timeoutMs === null ? undefined : AbortSignal.timeout(options.timeoutMs),
    });
    return { status: response.status, json: (await response.json().catch(() => null)) as Record<string, unknown> | null };
  }

  const paidIn = (json: Record<string, unknown> | null) => json?.status === "COMPLETED";

  async function capture(order: Order): Promise<Status> {
    const requestId = randomUUID();
    for (let attempt = 1; attempt <= (options.retriesTransientErrors ? 3 : 1); attempt++) {
      try {
        const answer = await paypal("POST", `/v2/checkout/orders/${order.paypalOrderId}/capture`, { body: {}, requestId });
        if (answer.status >= 200 && answer.status < 300) return paidIn(answer.json) ? "PAID" : "PENDING";
        if (answer.status === 422) return "DECLINED";
        if (answer.status < 500) return "FAILED";
      } catch {
        // No answer in time: PayPal may have captured. Only a careful store asks.
        if (!options.asksPayPalAfterTimeout) return "FAILED";
        const order_ = await paypal("GET", `/v2/checkout/orders/${order.paypalOrderId}`);
        return paidIn(order_.json) ? "PAID" : "FAILED";
      }
    }
    return "FAILED";
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://store.local");
      const capturePath = /^\/integration-proof\/orders\/([A-Z0-9]+)\/capture$/.exec(url.pathname);
      if (request.method === "POST" && url.pathname === "/integration-proof/orders") {
        const { cartId } = (await body(request)) as { cartId: string };
        const created = await paypal("POST", "/v2/checkout/orders", {
          body: { intent: "CAPTURE", purchase_units: [{ amount: { currency_code: "USD", value: "10.00" } }] },
        });
        const id = created.json?.id;
        if (created.status !== 201 || typeof id !== "string") return send(response, 502, { error: "PayPal did not create the order" });
        orders.set(id, { paypalOrderId: id, cartId, status: "CREATED", fulfilments: 0 });
        return send(response, 201, { orderId: id });
      }
      if (request.method === "POST" && capturePath) {
        const order = orders.get(capturePath[1]);
        if (!order) return send(response, 404, { error: "No such order" });
        order.status = await capture(order);
        if (order.status === "PAID") order.fulfilments += 1;
        return send(response, 200, { status: order.status, message: MESSAGES[order.status] });
      }
      if (request.method === "GET" && url.pathname === "/integration-proof/state") {
        const cartId = url.searchParams.get("cartId");
        const mine = [...orders.values()].filter((order) => order.cartId === cartId);
        return send(response, 200, { contract: 1, orders: mine.map(({ paypalOrderId, status, fulfilments }) => ({ paypalOrderId, status, fulfilments })) });
      }
      send(response, 404, { error: "Not found" });
    } catch (error) {
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/integration-proof`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
