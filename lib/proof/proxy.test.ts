import { describe, expect, it } from "vitest";
import { classifyProxiedRequest, mockResponseHeader, sandboxUrl } from "./proxy";
import { REDACTED, redact, traceBody } from "./redact";
import { SCENARIOS } from "./scenarios";

describe("classifyProxiedRequest", () => {
  it.each([
    ["POST", "/v2/checkout/orders", "create"],
    ["GET", "/v2/checkout/orders/5O190127TN364715T", "get"],
    ["POST", "/v2/checkout/orders/5O190127TN364715T/capture", "capture"],
  ] as const)("forwards %s %s as %s", (method, path, operation) => {
    expect(classifyProxiedRequest(method, path)).toBe(operation);
  });

  it.each([
    ["GET", "/v2/checkout/orders"],
    ["POST", "/v2/checkout/orders/5O190127TN364715T/confirm-payment-source"],
    ["POST", "/v2/payments/captures/0MM28060KS143004L/refund"],
    ["POST", "/v1/oauth2/token"],
    ["GET", "/v2/checkout/orders/5O190127TN364715T/../../../v1/oauth2/token"],
    ["DELETE", "/v2/checkout/orders/5O190127TN364715T"],
  ])("refuses %s %s", (method, path) => {
    expect(classifyProxiedRequest(method, path)).toBeNull();
  });
});

describe("sandboxUrl", () => {
  it("always lands on the sandbox host", () => {
    expect(sandboxUrl("/v2/checkout/orders").href).toBe("https://api-m.sandbox.paypal.com/v2/checkout/orders");
  });

  it.each(["//example.com/v2/checkout/orders", "https://api-m.paypal.com/v2/checkout/orders"])(
    "throws for %s",
    (path) => {
      expect(() => sandboxUrl(path)).toThrow(/not allowed/);
    },
  );
});

describe("mockResponseHeader", () => {
  it("uses the format the sandbox accepted", () => {
    expect(mockResponseHeader("INSTRUMENT_DECLINED")).toBe('{"mock_application_codes":"INSTRUMENT_DECLINED"}');
  });
});

describe("scenario faults", () => {
  it("S1 declines every capture and nothing else", () => {
    expect(SCENARIOS.S1.fault({ operation: "capture", captureAttempt: 1 })).toBe("INSTRUMENT_DECLINED");
    expect(SCENARIOS.S1.fault({ operation: "capture", captureAttempt: 2 })).toBe("INSTRUMENT_DECLINED");
    expect(SCENARIOS.S1.fault({ operation: "create", captureAttempt: 0 })).toBeNull();
    expect(SCENARIOS.S1.fault({ operation: "get", captureAttempt: 1 })).toBeNull();
  });

  it("S2 fails the first capture attempt only", () => {
    expect(SCENARIOS.S2.fault({ operation: "capture", captureAttempt: 1 })).toBe("INTERNAL_SERVER_ERROR");
    expect(SCENARIOS.S2.fault({ operation: "capture", captureAttempt: 2 })).toBeNull();
    expect(SCENARIOS.S2.fault({ operation: "create", captureAttempt: 0 })).toBeNull();
    expect(SCENARIOS.S2.fault({ operation: "get", captureAttempt: 1 })).toBeNull();
  });
});

describe("redact", () => {
  it("removes card data at any depth and keeps the rest", () => {
    const body = {
      payment_source: { card: { number: "4012888888881881", expiry: "2029-12", security_code: "123", name: "A" } },
      purchase_units: [{ amount: { value: "10.00" } }],
    };
    expect(redact(body)).toEqual({
      payment_source: { card: { number: REDACTED, expiry: REDACTED, security_code: REDACTED, name: "A" } },
      purchase_units: [{ amount: { value: "10.00" } }],
    });
  });

  it("removes credentials whatever their case", () => {
    expect(redact({ Authorization: "Bearer x", access_token: "y" })).toEqual({ Authorization: REDACTED, access_token: REDACTED });
  });

  it("removes the scenario's run key from the request the buyer sends the store", () => {
    expect(redact({ cartId: "cart-1", run: { runId: "r", runKey: "k" } })).toEqual({
      cartId: "cart-1",
      run: { runId: "r", runKey: REDACTED },
    });
  });

  it("does not change the value it is given", () => {
    const body = { card: { number: "4012888888881881" } };
    redact(body);
    expect(body.card.number).toBe("4012888888881881");
  });
});

describe("traceBody", () => {
  it("parses and redacts JSON", () => {
    expect(traceBody('{"card":{"number":"4012888888881881"}}')).toEqual({ card: { number: REDACTED } });
  });

  it("never stores text that is not JSON", () => {
    expect(traceBody("number=4012888888881881")).toEqual({ unparsed: "23 bytes, not JSON" });
  });

  it("keeps an empty body empty", () => {
    expect(traceBody("")).toBeNull();
  });
});
