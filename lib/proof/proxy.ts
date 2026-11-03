// Pure parts of the fault-injection proxy: which PayPal requests it forwards and where to.
import { SANDBOX_API_BASE, SANDBOX_HOST } from "../paypal/client";
import { ORDERS_PATH } from "../paypal/orders";

/** The Orders v2 calls a reference store makes. The proxy forwards nothing else. */
export type ProxiedOperation = "create" | "get" | "capture";

const ORDER_ID = "[A-Z0-9]{1,36}";
const ROUTES: { method: string; pattern: RegExp; operation: ProxiedOperation }[] = [
  { method: "POST", pattern: new RegExp(`^${ORDERS_PATH}$`), operation: "create" },
  { method: "GET", pattern: new RegExp(`^${ORDERS_PATH}/${ORDER_ID}$`), operation: "get" },
  { method: "POST", pattern: new RegExp(`^${ORDERS_PATH}/${ORDER_ID}/capture$`), operation: "capture" },
];

export function classifyProxiedRequest(method: string, path: string): ProxiedOperation | null {
  return ROUTES.find((route) => route.method === method && route.pattern.test(path))?.operation ?? null;
}

/** The upstream URL for a proxied path. Throws unless it lands on the sandbox host. */
export function sandboxUrl(path: string): URL {
  const url = new URL(path, SANDBOX_API_BASE);
  if (url.protocol !== "https:" || url.host !== SANDBOX_HOST) {
    throw new Error(`Proxy upstream is not allowed: ${url.host}`);
  }
  return url;
}

/** Negative-testing codes the proxy injects. Both are confirmed in docs/sandbox-findings.md. */
export type MockCode = "INSTRUMENT_DECLINED" | "INTERNAL_SERVER_ERROR";

/** Value of the PayPal-Mock-Response header, in the format the sandbox capability check used. */
export function mockResponseHeader(code: MockCode): string {
  return JSON.stringify({ mock_application_codes: code });
}
