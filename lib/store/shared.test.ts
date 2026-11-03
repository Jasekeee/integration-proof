import { describe, expect, it } from "vitest";
import type { PayPalResponse } from "../paypal/client";
import type { PayPalCapture, PayPalOrder } from "../paypal/orders";
import {
  backoffMs,
  classifyCapture,
  reconciliationFrom,
  statusFromEventType,
  statusFromPayPal,
} from "./shared";

function response(status: number, body: unknown): PayPalResponse {
  return { kind: "response", status, body, debugId: "f000000000000", durationMs: 1 };
}

function order(status: string, captures: PayPalCapture[] = []): PayPalOrder {
  return { id: "5O190127TN364715T", status, purchase_units: [{ payments: { captures } }] };
}

const NO_RESPONSE: PayPalResponse = {
  kind: "no_response",
  reason: "timeout",
  message: "TimeoutError",
  durationMs: 15_000,
};

describe("classifyCapture", () => {
  it("settles a completed capture as PAID", () => {
    const outcome = classifyCapture(response(201, order("COMPLETED", [{ id: "CAP1", status: "COMPLETED" }])));
    expect(outcome).toEqual({ kind: "settled", result: { status: "PAID", captureId: "CAP1" } });
  });

  it("settles a replayed capture (200, same capture id) the same way", () => {
    const outcome = classifyCapture(response(200, order("COMPLETED", [{ id: "CAP1", status: "COMPLETED" }])));
    expect(outcome).toEqual({ kind: "settled", result: { status: "PAID", captureId: "CAP1" } });
  });

  it("settles a pending capture as PENDING, not PAID", () => {
    const outcome = classifyCapture(response(201, order("COMPLETED", [{ id: "CAP1", status: "PENDING" }])));
    expect(outcome).toEqual({ kind: "settled", result: { status: "PENDING", captureId: "CAP1" } });
  });

  it("reads 422 INSTRUMENT_DECLINED as a decline", () => {
    const body = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "INSTRUMENT_DECLINED" }] };
    expect(classifyCapture(response(422, body))).toEqual({ kind: "declined" });
  });

  it("reads 422 ORDER_ALREADY_CAPTURED as already captured", () => {
    const body = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_ALREADY_CAPTURED" }] };
    expect(classifyCapture(response(422, body))).toEqual({ kind: "already_captured" });
  });

  it("reads a 5xx as transient", () => {
    const body = { name: "INTERNAL_SERVER_ERROR", details: [{ issue: "INTERNAL_SERVER_ERROR" }] };
    expect(classifyCapture(response(500, body))).toEqual({ kind: "transient" });
  });

  it("reads a missing response as unknown, never as a failure", () => {
    expect(classifyCapture(NO_RESPONSE)).toEqual({ kind: "unknown" });
  });

  it("reads a 2xx without a capture as unknown", () => {
    expect(classifyCapture(response(201, { unexpected: true }))).toEqual({ kind: "unknown" });
  });

  it("reports other 4xx issues as rejected", () => {
    const body = { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "ORDER_NOT_APPROVED" }] };
    expect(classifyCapture(response(422, body))).toEqual({ kind: "rejected", issues: ["ORDER_NOT_APPROVED"] });
  });
});

describe("reconciliationFrom", () => {
  it("returns the capture result PayPal reports", () => {
    const read = response(200, order("COMPLETED", [{ id: "CAP1", status: "COMPLETED" }]));
    expect(reconciliationFrom(read)).toEqual({ status: "PAID", captureId: "CAP1" });
  });

  it("returns not_captured for an approved order with no capture", () => {
    expect(reconciliationFrom(response(200, order("APPROVED")))).toBe("not_captured");
  });

  it("returns unknown when PayPal cannot be read", () => {
    expect(reconciliationFrom(NO_RESPONSE)).toBe("unknown");
    expect(reconciliationFrom(response(503, null))).toBe("unknown");
  });
});

describe("statusFromPayPal", () => {
  it("uses the latest capture", () => {
    const result = statusFromPayPal(order("COMPLETED", [{ id: "CAP1", status: "REFUNDED" }]));
    expect(result).toEqual({ status: "REFUNDED", captureId: "CAP1" });
  });

  it("returns null while the order has no capture", () => {
    expect(statusFromPayPal(order("APPROVED"))).toBeNull();
  });
});

describe("statusFromEventType", () => {
  it("maps capture events to the status they suggest", () => {
    expect(statusFromEventType("PAYMENT.CAPTURE.COMPLETED")).toBe("PAID");
    expect(statusFromEventType("PAYMENT.CAPTURE.DECLINED")).toBe("DECLINED");
    expect(statusFromEventType("PAYMENT.CAPTURE.REFUNDED")).toBe("REFUNDED");
  });

  it("ignores events that do not change a capture", () => {
    expect(statusFromEventType("CHECKOUT.ORDER.APPROVED")).toBeNull();
  });
});

describe("backoffMs", () => {
  it("doubles from 500 ms", () => {
    expect([1, 2, 3].map(backoffMs)).toEqual([500, 1000, 2000]);
  });
});
