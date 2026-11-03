import { describe, expect, it } from "vitest";
import type { OrderStatus } from "../../db/schema";
import type { PayPalOrderTruth, ScenarioState, StoreOrderState, TraceEntry } from "../types";
import { assertS1, assertS2, chargesPerCart } from ".";

const ORDER = "5O190127TN364715T";
const SECOND_ORDER = "8VC12345AB678901C";

function buyerCapture(httpStatus: number | null, responseBody: unknown, seq = 3): TraceEntry {
  return { seq, actor: "buyer", method: "POST", path: `/api/store/naive/orders/${ORDER}/capture`, httpStatus, responseBody };
}

function storeCapture(httpStatus: number | null, seq: number): TraceEntry {
  return { seq, actor: "store", method: "POST", path: `/v2/checkout/orders/${ORDER}/capture`, httpStatus, responseBody: null };
}

function storeOrder(status: OrderStatus, paypalOrderId = ORDER): StoreOrderState {
  return { paypalOrderId, status, fulfilments: 0 };
}

function paypalOrder(captures: string[], id = ORDER): PayPalOrderTruth {
  return {
    id,
    status: captures.length > 0 ? "COMPLETED" : "APPROVED",
    captures: captures.map((status, index) => ({ id: `CAP${index}`, status })),
  };
}

function state(store: StoreOrderState[], paypal: PayPalOrderTruth[]): ScenarioState {
  return { store, paypal };
}

const DECLINED_ANSWER = { status: "DECLINED", message: "Your card was declined. Try another card or payment method." };

describe("chargesPerCart", () => {
  it("counts completed captures across every order of the cart", () => {
    expect(chargesPerCart([paypalOrder(["COMPLETED"]), paypalOrder(["COMPLETED"], SECOND_ORDER)])).toBe(2);
  });

  it("counts a capture that was refunded later as a charge", () => {
    expect(chargesPerCart([paypalOrder(["REFUNDED"]), paypalOrder(["PARTIALLY_REFUNDED"], SECOND_ORDER)])).toBe(2);
  });

  it("does not count declined, pending or failed captures", () => {
    expect(chargesPerCart([paypalOrder(["DECLINED", "PENDING", "FAILED"])])).toBe(0);
  });

  it("is zero for an order with no capture", () => {
    expect(chargesPerCart([paypalOrder([])])).toBe(0);
  });
});

describe("assertS1", () => {
  it("passes when the order stays unpaid, the buyer sees a decline and nothing is charged", () => {
    const result = assertS1([storeCapture(422, 2), buyerCapture(200, DECLINED_ANSWER)], state([storeOrder("DECLINED")], [paypalOrder([])]));
    expect(result).toEqual({
      verdict: "PASS",
      reason: "The order stayed unpaid, the buyer was told the card was declined, and PayPal shows no charge for the cart.",
    });
  });

  it("fails when the store marks the order PAID and PayPal shows a charge", () => {
    const paid = { status: "PAID", message: "Payment received. Thank you for your order." };
    const result = assertS1([buyerCapture(200, paid)], state([storeOrder("PAID")], [paypalOrder(["COMPLETED"])]));
    expect(result).toEqual({
      verdict: "FAIL",
      reason:
        `The store marked order ${ORDER} PAID; the buyer was told "Payment received. Thank you for your order." ` +
        "(PAID) instead of a decline; PayPal shows 1 charge for the cart.",
    });
  });

  it("fails when the buyer gets a server error instead of a decline", () => {
    const crash = { error: "internal_error", message: "Something went wrong on our side." };
    const result = assertS1([buyerCapture(500, crash)], state([storeOrder("CREATED")], [paypalOrder([])]));
    expect(result).toEqual({ verdict: "FAIL", reason: "The buyer got HTTP 500 instead of a decline." });
  });

  it("fails when the buyer is told the payment failed rather than declined", () => {
    const failed = { status: "FAILED", message: "Payment failed. Please try again." };
    const result = assertS1([buyerCapture(200, failed)], state([storeOrder("FAILED")], [paypalOrder([])]));
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toBe('The buyer was told "Payment failed. Please try again." (FAILED) instead of a decline.');
  });

  it("fails when the capture request got no response", () => {
    const result = assertS1([buyerCapture(null, null)], state([storeOrder("CREATED")], [paypalOrder([])]));
    expect(result).toEqual({ verdict: "FAIL", reason: "The buyer's capture request got no response." });
  });

  it("fails when the trace has no capture request at all", () => {
    const result = assertS1([], state([storeOrder("CREATED")], [paypalOrder([])]));
    expect(result).toEqual({ verdict: "FAIL", reason: "The buyer's capture request is missing from the trace." });
  });

  it("judges the buyer's last answer", () => {
    const failed = { status: "FAILED", message: "Payment failed. Please try again." };
    const trace = [buyerCapture(200, failed, 3), buyerCapture(200, DECLINED_ANSWER, 6)];
    expect(assertS1(trace, state([storeOrder("DECLINED")], [paypalOrder([])])).verdict).toBe("PASS");
  });
});

describe("assertS2", () => {
  it("passes when the store retries the 500 and the order ends PAID with one charge", () => {
    const trace = [storeCapture(500, 2), storeCapture(201, 3), buyerCapture(200, { status: "PAID", message: "ok" }, 4)];
    const result = assertS2(trace, state([storeOrder("PAID")], [paypalOrder(["COMPLETED"])]));
    expect(result).toEqual({
      verdict: "PASS",
      reason:
        "The order is PAID with exactly 1 charge at PayPal. The store sent 2 capture requests to PayPal: " +
        "HTTP 500, then HTTP 201.",
    });
  });

  it("fails when the store treats the 500 as final and loses the sale", () => {
    const trace = [storeCapture(500, 2), buyerCapture(200, { status: "FAILED", message: "Payment failed." }, 3)];
    const result = assertS2(trace, state([storeOrder("FAILED")], [paypalOrder([])]));
    expect(result).toEqual({
      verdict: "FAIL",
      reason:
        `PayPal shows 0 charges for the cart, not 1; the store marked order ${ORDER} FAILED. ` +
        "The store sent 1 capture request to PayPal: HTTP 500.",
    });
  });

  it("fails when the cart is charged twice, even if every order is PAID", () => {
    const result = assertS2(
      [storeCapture(201, 2)],
      state(
        [storeOrder("PAID"), storeOrder("PAID", SECOND_ORDER)],
        [paypalOrder(["COMPLETED"]), paypalOrder(["COMPLETED"], SECOND_ORDER)],
      ),
    );
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toMatch(/^PayPal shows 2 charges for the cart, not 1\./);
  });

  it("fails when PayPal charged the cart but the store does not say PAID", () => {
    const result = assertS2([storeCapture(null, 2)], state([storeOrder("PENDING")], [paypalOrder(["COMPLETED"])]));
    expect(result).toEqual({
      verdict: "FAIL",
      reason: `The store marked order ${ORDER} PENDING. The store sent 1 capture request to PayPal: no response.`,
    });
  });

  it("fails when the store has no order for the cart", () => {
    const result = assertS2([], state([], [paypalOrder([])]));
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toContain("the store has no order for the cart");
    expect(result.reason).toContain("no capture request to PayPal");
  });
});
