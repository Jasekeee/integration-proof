// The bench's network: global fetch answered in process. The app's own origin goes to the real route
// handlers, the PayPal sandbox to the model, and every other host is refused, so nothing on the
// bench reaches the internet.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PayPalModel, SANDBOX_ORIGIN } from "./paypal-model";

export const APP_ORIGIN = "http://localhost:3000";

type Handler = (request: Request, context: { params: Promise<Record<string, unknown>> }) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  file: string;
  params: (match: RegExpExecArray) => Record<string, unknown>;
  /** The runner reads store state while it waits for webhooks; PayPal delivers them meanwhile. */
  deliversWebhooks?: boolean;
}

/** The routes the runner, the store and PayPal call during a run. */
const ROUTES: Route[] = [
  {
    method: "POST",
    pattern: /^\/api\/store\/([^/]+)\/orders$/,
    file: "app/api/store/[mode]/orders/route.ts",
    params: (m) => ({ mode: m[1] }),
  },
  {
    method: "POST",
    pattern: /^\/api\/store\/([^/]+)\/orders\/([^/]+)\/capture$/,
    file: "app/api/store/[mode]/orders/[orderId]/capture/route.ts",
    params: (m) => ({ mode: m[1], orderId: m[2] }),
  },
  {
    method: "GET",
    pattern: /^\/api\/store\/([^/]+)\/state$/,
    file: "app/api/store/[mode]/state/route.ts",
    params: (m) => ({ mode: m[1] }),
    deliversWebhooks: true,
  },
  { method: "POST", pattern: /^\/api\/store\/webhooks-router$/, file: "app/api/store/webhooks-router/route.ts", params: () => ({}) },
  ...["GET", "POST"].map((method) => ({
    method,
    pattern: /^\/api\/proxy\/([^/]+)\/([^/]+)\/(.+)$/,
    file: "app/api/proxy/[runId]/[runKey]/[...path]/route.ts",
    params: (m: RegExpExecArray) => ({ runId: m[1], runKey: m[2], path: m[3].split("/").map(decodeURIComponent) }),
  })),
];

/** Rejects like fetch does when the caller's signal aborts, for example on a store timeout. */
function abortable(work: Promise<Response>, signal: AbortSignal | null | undefined): Promise<Response> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

export interface Network {
  /** Requests that left the bench's two origins. Each one is refused. */
  readonly refused: string[];
  restore(): void;
}

/** Replaces global fetch for one run. `root` is the checkout whose route handlers answer. */
export function installNetwork(root: string, model: PayPalModel): Network {
  const original = globalThis.fetch;
  const refused: string[] = [];
  const modules = new Map<string, Promise<Record<string, Handler>>>();
  let deliveries: Promise<void> = Promise.resolve();

  const handlerFor = (file: string, method: string): Promise<Handler> => {
    if (!modules.has(file)) modules.set(file, import(pathToFileURL(path.join(root, file)).href));
    return modules.get(file)!.then((module) => module[method]);
  };

  const app = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    for (const route of ROUTES) {
      const match = route.method === request.method ? route.pattern.exec(url.pathname) : null;
      if (!match) continue;
      if (route.deliversWebhooks) await deliverPending();
      const handler = await handlerFor(route.file, route.method);
      return handler(request, { params: Promise.resolve(route.params(match)) });
    }
    refused.push(`${request.method} ${url.pathname}`);
    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  };

  /** PayPal's deliveries, one at a time, to the router as PayPal would post them. */
  const deliverPending = (): Promise<void> => {
    deliveries = deliveries.then(async () => {
      for (const delivery of model.takeDeliveries()) {
        const request = new Request(`${APP_ORIGIN}/api/store/webhooks-router`, {
          method: "POST",
          headers: { ...delivery.headers, "content-type": "application/json" },
          body: delivery.body,
        });
        await app(request);
      }
    });
    return deliveries;
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== APP_ORIGIN && url.origin !== SANDBOX_ORIGIN) {
      refused.push(`${request.method} ${url.origin}${url.pathname}`);
      throw new TypeError(`fetch failed: the bench has no network (${url.origin})`);
    }
    const work = url.origin === APP_ORIGIN ? app(request) : model.handle(request);
    return abortable(work, init?.signal ?? request.signal);
  }) as typeof fetch;

  return {
    refused,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}
