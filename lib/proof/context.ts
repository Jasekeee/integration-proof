// Which base URL and timeout a store uses for one order. The proxy override is honoured only from
// the runner: a new order needs the scenario's secret run key, and an existing order uses the proxy
// only if it was created that way. The URL comes from server config, so no caller picks the host.
import { timingSafeEqual } from "node:crypto";
import { proxyBaseUrl } from "../paypal/client";
import type { StoreContext } from "../store/shared";
import { findActiveScenario } from "./repository";

/** The proxy for a new order of a running scenario, or null unless the run key matches. */
export async function newOrderRunContext(input: {
  runId: string;
  cartId: string;
  runKey: string;
}): Promise<StoreContext | null> {
  const scenario = await findActiveScenario(input.runId, input.cartId);
  if (!scenario || !sameKey(scenario.runKey, input.runKey)) return null;
  return { baseUrl: proxyBaseUrl(input.runId, scenario.runKey), timeoutMs: scenario.storeTimeoutMs };
}

/** The proxy for an order the runner created, while its scenario is running; otherwise null. */
export async function orderRunContext(order: { runId: string | null; cartId: string }): Promise<StoreContext | null> {
  if (!order.runId) return null;
  const scenario = await findActiveScenario(order.runId, order.cartId);
  if (!scenario) return null;
  return { baseUrl: proxyBaseUrl(order.runId, scenario.runKey), timeoutMs: scenario.storeTimeoutMs };
}

function sameKey(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
