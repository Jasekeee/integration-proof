// A small store that sells one item through PayPal Checkout (Orders v2), written the way many
// integrations are: it works on a good day and makes two common mistakes on a bad one. Both are
// marked "MISTAKE" below, with what a correct store does instead. The Integration Proof CLI finds
// them: S2 and S3 fail, S1 passes.
//
//   PAYPAL_API_BASE=http://127.0.0.1:8787 npm start
//
// Environment:
//   PORT                  where the store listens (default 4000)
//   PAYPAL_API_BASE       PayPal's API, or the CLI's proxy during a proof (default: the sandbox)
//   PAYPAL_CLIENT_ID      the store's sandbox app
//   PAYPAL_CLIENT_SECRET
//   PAYPAL_TIMEOUT_MS     how long a PayPal call may take (default 8000)
import express from "express";

const PORT = Number(process.env.PORT ?? 4000);
const PAYPAL_API_BASE = (process.env.PAYPAL_API_BASE ?? "https://api-m.sandbox.paypal.com").replace(/\/$/, "");
const PAYPAL_TIMEOUT_MS = Number(process.env.PAYPAL_TIMEOUT_MS ?? 8000);
const PRICE = { currency_code: "USD", value: "10.00" };

const MESSAGES = {
  PAID: "Payment received. Thank you for your order.",
  DECLINED: "Your card was declined. Try another card or payment method.",
  FAILED: "Payment failed. Please try again.",
};

/** The store's orders, kept in memory: PayPal order id -> { cartId, status, fulfilments }. */
const orders = new Map();

// --- PayPal client -------------------------------------------------------------------------------

let token = null;

async function accessToken() {
  if (token && Date.now() < token.refreshAt) return token.value;
  const credentials = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: { authorization: `Basic ${credentials}`, "content-type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(PAYPAL_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`PayPal token request failed: HTTP ${response.status}`);
  const body = await response.json();
  token = { value: body.access_token, refreshAt: Date.now() + (body.expires_in - 300) * 1000 };
  return token.value;
}

/** One PayPal call. A call that takes longer than PAYPAL_TIMEOUT_MS throws. */
async function paypal(method, path, body) {
  const response = await fetch(`${PAYPAL_API_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(PAYPAL_TIMEOUT_MS),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

// --- Checkout ------------------------------------------------------------------------------------

async function createOrder(cartId) {
  const created = await paypal("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    purchase_units: [{ amount: PRICE }],
  });
  if (created.status !== 201) throw new Error(`PayPal did not create the order: HTTP ${created.status}`);
  orders.set(created.body.id, { cartId, status: "CREATED", fulfilments: 0 });
  return created.body.id;
}

async function captureOrder(orderId) {
  const order = orders.get(orderId);
  let status;
  try {
    // MISTAKE 1: one attempt and no PayPal-Request-Id. A 5xx from PayPal is temporary and captured
    // nothing; a correct store retries with backoff and the same PayPal-Request-Id, which makes the
    // retry safe. Here the buyer is told the payment failed and the sale is lost (S2).
    const captured = await paypal("POST", `/v2/checkout/orders/${orderId}/capture`, {});
    if (captured.status === 201 || captured.status === 200) status = "PAID";
    else if (captured.body?.details?.[0]?.issue === "INSTRUMENT_DECLINED") status = "DECLINED";
    else status = "FAILED";
  } catch {
    // MISTAKE 2: a timeout read as a failed payment. PayPal may have captured before its answer got
    // lost; a correct store asks PayPal (GET /v2/checkout/orders/{id}) before it answers the buyer.
    // Here the buyer is told the payment failed, pays again, and the cart is charged twice (S3).
    status = "FAILED";
  }
  order.status = status;
  if (status === "PAID") order.fulfilments += 1;
  return status;
}

// --- Routes --------------------------------------------------------------------------------------

const app = express();
app.use(express.json());

// What the storefront calls when a buyer checks out.
app.post("/api/orders", async (request, response) => {
  try {
    response.status(201).json({ orderId: await createOrder(String(request.body?.cartId ?? "")) });
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

app.post("/api/orders/:orderId/capture", async (request, response) => {
  if (!orders.has(request.params.orderId)) return response.status(404).json({ error: "No such order" });
  const status = await captureOrder(request.params.orderId);
  response.json({ status, message: MESSAGES[status] });
});

// The Integration Proof contract, version 1 (docs/store-contract.md in the Integration Proof
// repository): a thin adapter that calls the same checkout code the storefront does.
const proof = express.Router();

proof.post("/orders", async (request, response) => {
  const cartId = request.body?.cartId;
  if (typeof cartId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(cartId)) return response.status(400).json({ error: "cartId" });
  try {
    response.status(201).json({ orderId: await createOrder(cartId) });
  } catch (error) {
    response.status(502).json({ error: error.message });
  }
});

proof.post("/orders/:orderId/capture", async (request, response) => {
  if (!orders.has(request.params.orderId)) return response.status(404).json({ error: "No such order" });
  const status = await captureOrder(request.params.orderId);
  response.json({ status, message: MESSAGES[status] });
});

proof.get("/state", (request, response) => {
  const cartId = request.query.cartId;
  const mine = [...orders.entries()]
    .filter(([, order]) => order.cartId === cartId)
    .map(([paypalOrderId, order]) => ({ paypalOrderId, status: order.status, fulfilments: order.fulfilments }));
  response.json({ contract: 1, orders: mine });
});

app.use("/integration-proof", proof);
app.get("/health", (request, response) => response.json({ status: "ok" }));

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Example store on http://127.0.0.1:${PORT}, PayPal at ${PAYPAL_API_BASE}`);
});
