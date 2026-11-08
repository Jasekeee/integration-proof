// The fault-injection proxy, running inside the CLI on the loopback interface. The store under test
// points its PayPal base URL here; the proxy injects the running scenario's fault and forwards to
// the PayPal sandbox only. It reuses the pure rules of the hosted proxy (lib/proof/proxy.ts), so
// both inject the same faults into the same requests.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { classifyProxiedRequest, describeFault, mockResponseHeader, sandboxUrl } from "../lib/proof/proxy";
import { traceBody } from "../lib/proof/redact";
import type { Scenario } from "../lib/proof/scenarios";
import type { CliStep } from "./steps";

/** Longer than any store's own timeout, so the store, not the proxy, decides when to give up. */
const UPSTREAM_TIMEOUT_MS = 60_000;
/** Request headers forwarded to PayPal. Nothing else the store sends reaches the sandbox. */
const FORWARDED_HEADERS = ["authorization", "content-type", "accept", "prefer", "paypal-request-id"];
/** The OAuth token request. Forwarded untouched and never recorded: it carries the store's credentials. */
const TOKEN_PATH = "/v1/oauth2/token";

export interface LocalProxy {
  /** The base URL the store uses for PayPal while the CLI runs, e.g. http://127.0.0.1:8787. */
  url: string;
  /** From now on, requests get this scenario's faults and are recorded with `record`. */
  begin(scenario: Scenario, record: (step: CliStep) => void): void;
  /** Waits for the requests in flight, a held answer included. The scenario keeps running. */
  settle(): Promise<void>;
  /** Settles, then stops applying the scenario's faults and recording. */
  end(): Promise<void>;
  close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startProxy(options: { port: number; holdMs: number }): Promise<LocalProxy> {
  let current: { scenario: Scenario; record: (step: CliStep) => void; captureAttempt: number } | null = null;
  const inFlight = new Set<Promise<void>>();

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://proxy.local").pathname;
    const body = method === "POST" ? await readBody(request) : null;
    const headers = new Headers();
    for (const name of FORWARDED_HEADERS) {
      const value = request.headers[name];
      if (typeof value === "string") headers.set(name, value);
    }

    if (method === "POST" && path === TOKEN_PATH) {
      const upstream = await fetch(sandboxUrl(TOKEN_PATH), { method, headers, body: body ?? undefined, redirect: "manual" }).catch(
        () => null,
      );
      if (!upstream) return sendJson(response, 502, { name: "UPSTREAM_UNREACHABLE", message: "PayPal did not answer." });
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      response.end(await upstream.text());
      return;
    }

    const operation = classifyProxiedRequest(method, path);
    if (!operation) {
      return sendJson(response, 404, {
        name: "NOT_PROXIED",
        message: "The Integration Proof proxy forwards only the OAuth token and the Orders v2 create, get and capture calls.",
      });
    }
    const scenario = current;
    if (!scenario) return sendJson(response, 503, { name: "NO_SCENARIO", message: "No scenario is running." });

    if (operation === "capture") scenario.captureAttempt += 1;
    const fault = scenario.scenario.fault({ operation, captureAttempt: scenario.captureAttempt });
    if (fault?.kind === "mock") headers.set("PayPal-Mock-Response", mockResponseHeader(fault.code));

    const startedAt = new Date();
    const startedMs = performance.now();
    let upstream: Response | null = null;
    let text = "";
    let note: string | null = null;
    try {
      upstream = await fetch(sandboxUrl(path), {
        method,
        headers,
        body: body ?? undefined,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        redirect: "manual",
      });
      text = await upstream.text();
    } catch (error) {
      note = `PayPal did not answer the proxied request: ${error instanceof Error ? error.message : String(error)}`;
    }
    const holding = fault?.kind === "hold_response" && upstream !== null;
    if (holding) note = `PayPal answered; the proxy holds the answer for ${options.holdMs} ms before passing it on.`;

    // Recorded before the hold, so the evidence does not depend on the store still waiting.
    scenario.record({
      startMs: startedMs,
      actor: "store",
      target: "paypal",
      startedAt: startedAt.toISOString(),
      durationMs: Math.round(performance.now() - startedMs),
      method,
      path,
      httpStatus: upstream?.status ?? null,
      debugId: upstream?.headers.get("paypal-debug-id") ?? null,
      paypalRequestId: request.headers["paypal-request-id"]?.toString() ?? null,
      fault: fault ? describeFault(fault, options.holdMs) : null,
      requestBody: traceBody(body),
      responseBody: traceBody(text),
      note,
    });

    if (!upstream) return sendJson(response, 502, { name: "UPSTREAM_UNREACHABLE", message: "PayPal did not answer the proxied request." });
    if (holding) await sleep(options.holdMs);
    if (response.destroyed) return;
    const out: Record<string, string> = { "cache-control": "no-store" };
    for (const name of ["content-type", "paypal-debug-id"]) {
      const value = upstream.headers.get(name);
      if (value !== null) out[name] = value;
    }
    response.writeHead(upstream.status, out);
    response.end(upstream.status === 204 || upstream.status === 304 ? undefined : text);
  }

  const server = createServer((request, response) => {
    const work = handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) sendJson(response, 500, { name: "PROXY_ERROR", message: error instanceof Error ? error.message : String(error) });
      else response.destroy();
    });
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback only: nothing outside this machine can reach the proxy.
    server.listen(options.port, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    begin(scenario, record) {
      current = { scenario, record, captureAttempt: 0 };
    },
    async settle() {
      await Promise.allSettled([...inFlight]);
    },
    async end() {
      await Promise.allSettled([...inFlight]);
      current = null;
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
