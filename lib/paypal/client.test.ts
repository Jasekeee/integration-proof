import { describe, expect, it } from "vitest";
import { assertAllowedBaseUrl, paypalIssues, paypalRequest, SANDBOX_API_BASE } from "./client";

describe("assertAllowedBaseUrl", () => {
  it("allows the sandbox", () => {
    expect(() => assertAllowedBaseUrl(SANDBOX_API_BASE)).not.toThrow();
  });

  it.each([
    "https://api-m.paypal.com",
    "https://api-m.sandbox.paypal.com.example.com",
    "http://api-m.sandbox.paypal.com",
    "https://example.com",
  ])("rejects %s", (baseUrl) => {
    expect(() => assertAllowedBaseUrl(baseUrl)).toThrow(/not allowed/);
  });

  it("throws before any request is sent", async () => {
    await expect(
      paypalRequest({ baseUrl: "https://api-m.paypal.com", method: "GET", path: "/v2/x", token: "t", timeoutMs: 1 }),
    ).rejects.toThrow(/not allowed/);
  });
});

describe("paypalIssues", () => {
  it("returns detail issue codes", () => {
    const body = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] };
    expect(paypalIssues(body)).toEqual(["ORDER_ALREADY_CAPTURED"]);
  });

  it("falls back to the error name", () => {
    expect(paypalIssues({ name: "INTERNAL_SERVER_ERROR" })).toEqual(["INTERNAL_SERVER_ERROR"]);
  });

  it("returns nothing for a body that is not an error", () => {
    expect(paypalIssues(null)).toEqual([]);
  });
});
