import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_API_BASE, type PayPalResponse } from "../paypal/client";
import { getOrder } from "../paypal/orders";
import { refundCapture } from "../paypal/payments";
import { attemptNote, exhaustedMessage, isRetryable, withRetries } from "./retry";

function answer(status: number): PayPalResponse {
  return { kind: "response", status, body: {}, debugId: "f00d", durationMs: 1 };
}
const TIMEOUT: PayPalResponse = { kind: "no_response", reason: "timeout", message: "TimeoutError", durationMs: 30_000 };
const NETWORK: PayPalResponse = { kind: "no_response", reason: "network", message: "ECONNRESET", durationMs: 5 };

/** A send that answers with each response in turn, and the delays the retry waited. */
function scripted(...responses: PayPalResponse[]) {
  const waits: number[] = [];
  const send = vi.fn(async (attempt: number) => responses[attempt - 1]);
  const wait = async (ms: number) => {
    waits.push(ms);
  };
  return { send, wait, waits };
}

describe("isRetryable", () => {
  it("retries a 5xx, a timeout and a network error, never a 2xx or a 4xx", () => {
    expect([answer(500), answer(503), TIMEOUT, NETWORK].every(isRetryable)).toBe(true);
    expect([answer(200), answer(201), answer(404), answer(422)].some(isRetryable)).toBe(false);
  });
});

describe("withRetries", () => {
  it("returns the first answer when it settles the request, with no wait", async () => {
    const { send, wait, waits } = scripted(answer(200));
    expect(await withRetries(send, { wait })).toMatchObject({ attempts: 1, exhausted: false, response: { status: 200 } });
    expect(waits).toEqual([]);
  });

  it("retries a 5xx and then a timeout with backoff, and returns the answer that settles it", async () => {
    const { send, wait, waits } = scripted(answer(503), TIMEOUT, answer(201));
    const result = await withRetries(send, { wait });
    expect(result).toMatchObject({ attempts: 3, exhausted: false, response: { status: 201 } });
    expect(send.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
    expect(waits).toEqual([500, 1000]);
  });

  it("does not retry a 4xx: PayPal has answered, and the same request would get the same answer", async () => {
    const { send, wait } = scripted(answer(422), answer(201));
    expect(await withRetries(send, { wait })).toMatchObject({ attempts: 1, exhausted: false, response: { status: 422 } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("gives up after 3 attempts and says so", async () => {
    const { send, wait } = scripted(NETWORK, answer(500), answer(502), answer(201));
    const result = await withRetries(send, { wait });
    expect(result).toMatchObject({ attempts: 3, exhausted: true, response: { status: 502 } });
    expect(send).toHaveBeenCalledTimes(3);
    expect(exhaustedMessage({ method: "GET", path: "/v2/checkout/orders/5O190127TN364715T" }, result)).toBe(
      "PayPal sandbox did not respond after 3 attempts: GET /v2/checkout/orders/5O190127TN364715T ended with HTTP 502.",
    );
  });
});

describe("attemptNote", () => {
  it("says nothing about a first attempt that settled the request", () => {
    expect(attemptNote(1, answer(200))).toBeNull();
  });

  it("names the attempt, what went wrong and when the next one starts", () => {
    expect(attemptNote(1, answer(503))).toBe("Attempt 1 of 3: HTTP 503. The runner tries again in 0.5 s.");
    expect(attemptNote(2, TIMEOUT)).toBe("Attempt 2 of 3: no response (timeout). The runner tries again in 1 s.");
    expect(attemptNote(3, answer(500))).toBe("Attempt 3 of 3: HTTP 500.");
    expect(attemptNote(2, answer(201))).toBe("Attempt 2 of 3.");
  });
});

describe("retried PayPal requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const call = { baseUrl: SANDBOX_API_BASE, token: "test-token", timeoutMs: 1000 };

  function stubFetch(...statuses: number[]) {
    const fetch = vi.fn(async () => {
      const status = statuses.shift() ?? 500;
      return new Response(JSON.stringify(status < 300 ? { id: "4AC48240EN136032W", status: "COMPLETED" } : { name: "INTERNAL_SERVER_ERROR" }), {
        status,
        headers: { "paypal-debug-id": "f00d" },
      });
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  function request(fetch: ReturnType<typeof stubFetch>, index: number): [string, RequestInit] {
    return fetch.mock.calls[index] as unknown as [string, RequestInit];
  }

  function url(fetch: ReturnType<typeof stubFetch>, index: number): string {
    return request(fetch, index)[0];
  }

  function header(fetch: ReturnType<typeof stubFetch>, index: number, name: string): string | undefined {
    return (request(fetch, index)[1].headers as Record<string, string>)[name];
  }

  it("send one refund with the same PayPal-Request-Id on every attempt", async () => {
    const fetch = stubFetch(503, 500, 200);
    const requestId = "6f1c1d7e-3f7a-4b64-9d3c-2d5f0e0b8a11";
    const result = await withRetries(() => refundCapture(call, { captureId: "16B6712761564310P", requestId }), {
      wait: async () => {},
    });
    expect(result).toMatchObject({ attempts: 3, exhausted: false, response: { status: 200 } });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (let index = 0; index < 3; index++) {
      expect(header(fetch, index, "PayPal-Request-Id")).toBe(requestId);
      expect(url(fetch, index)).toBe(`${SANDBOX_API_BASE}/v2/payments/captures/16B6712761564310P/refund`);
    }
  });

  it("read an order again after a 5xx, without a PayPal-Request-Id, which a GET does not take", async () => {
    const fetch = stubFetch(503, 200);
    const result = await withRetries(() => getOrder(call, "5O190127TN364715T"), { wait: async () => {} });
    expect(result).toMatchObject({ attempts: 2, exhausted: false });
    expect(header(fetch, 0, "PayPal-Request-Id")).toBeUndefined();
    expect(header(fetch, 1, "PayPal-Request-Id")).toBeUndefined();
  });
});
