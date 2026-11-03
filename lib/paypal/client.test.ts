import { describe, expect, it } from "vitest";
import { assertAllowedBaseUrl, paypalIssues, paypalRequest, proxyBaseUrl, SANDBOX_API_BASE } from "./client";

const RUN_ID = "3f1c2b9e-8d4a-4c1e-9f2b-6a7d8e9f0a1b";
const RUN_KEY = "a".repeat(64);

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

  it("allows the run's proxy on the app's own origin", () => {
    expect(proxyBaseUrl(RUN_ID, RUN_KEY)).toBe(`http://localhost:3000/api/proxy/${RUN_ID}/${RUN_KEY}`);
  });

  it.each([
    `http://localhost:3000/api/proxy/${RUN_ID}`,
    `http://localhost:3000/api/proxy/${RUN_ID}/${RUN_KEY}/v2`,
    `http://localhost:3000/api/proxy/not-a-run/${RUN_KEY}`,
    `http://localhost:3000/api/proxy/${RUN_ID}/S2`,
    `http://localhost:3000/api/proxy/${RUN_ID}/${"a".repeat(63)}`,
    `http://localhost:4000/api/proxy/${RUN_ID}/${RUN_KEY}`,
    `https://example.com/api/proxy/${RUN_ID}/${RUN_KEY}`,
  ])("rejects the proxy-like %s", (baseUrl) => {
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
