import { describe, expect, it } from "vitest";
import type { OrderStatus } from "../../db/schema";
import {
  FORGED_DELIVERY,
  REPLAYED_DELIVERY,
  WEBHOOK_ROUTER_PATH,
  type PayPalOrderTruth,
  type ScenarioState,
  type StoreOrderState,
  type TraceEntry,
} from "../types";
import { assertS1, assertS2, assertS3, assertS4, assertS5, assertS6, chargesPerCart, inconclusiveReason } from ".";

const ORDER = "5O190127TN364715T";
const SECOND_ORDER = "8VC12345AB678901C";

function buyerCapture(httpStatus: number | null, responseBody: unknown, seq = 3, orderId = ORDER): TraceEntry {
  const path = `/api/store/naive/orders/${orderId}/capture`;
  return { seq, actor: "buyer", method: "POST", path, httpStatus, fault: null, responseBody };
}

function buyerCreate(seq: number): TraceEntry {
  return { seq, actor: "buyer", method: "POST", path: "/api/store/naive/orders", httpStatus: 201, fault: null, responseBody: null };
}

function storeCapture(httpStatus: number | null, seq: number): TraceEntry {
  const path = `/v2/checkout/orders/${ORDER}/capture`;
  return { seq, actor: "store", method: "POST", path, httpStatus, fault: null, responseBody: null };
}

function routerDelivery(kind: string, httpStatus: number, outcome: string, seq = 9): TraceEntry {
  return { seq, actor: "runner", method: "POST", path: WEBHOOK_ROUTER_PATH, httpStatus, fault: kind, responseBody: { outcome } };
}

function storeOrder(status: OrderStatus, paypalOrderId = ORDER, fulfilments = 0): StoreOrderState {
  return { paypalOrderId, status, fulfilments };
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
    expect(result).toMatchObject({
      verdict: "PASS",
      reason: "The order stayed unpaid, the buyer was told the card was declined, and PayPal shows no charge for the cart.",
    });
  });

  it("fails when the store marks the order PAID and PayPal shows a charge", () => {
    const paid = { status: "PAID", message: "Payment received. Thank you for your order." };
    const result = assertS1([buyerCapture(200, paid)], state([storeOrder("PAID")], [paypalOrder(["COMPLETED"])]));
    expect(result).toMatchObject({
      verdict: "FAIL",
      reason:
        `The store marked order ${ORDER} PAID; the buyer was told "Payment received. Thank you for your order." ` +
        "(PAID) instead of a decline; PayPal shows 1 charge for the cart.",
    });
  });

  it("fails when the buyer gets a server error instead of a decline", () => {
    const crash = { error: "internal_error", message: "Something went wrong on our side." };
    const result = assertS1([buyerCapture(500, crash)], state([storeOrder("CREATED")], [paypalOrder([])]));
    expect(result).toMatchObject({ verdict: "FAIL", reason: "The buyer got HTTP 500 instead of a decline." });
  });

  it("fails when the buyer is told the payment failed rather than declined", () => {
    const failed = { status: "FAILED", message: "Payment failed. Please try again." };
    const result = assertS1([buyerCapture(200, failed)], state([storeOrder("FAILED")], [paypalOrder([])]));
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toBe('The buyer was told "Payment failed. Please try again." (FAILED) instead of a decline.');
  });

  it("fails when the capture request got no response", () => {
    const result = assertS1([buyerCapture(null, null)], state([storeOrder("CREATED")], [paypalOrder([])]));
    expect(result).toMatchObject({ verdict: "FAIL", reason: "The buyer's capture request got no response." });
  });

  it("fails when the trace has no capture request at all", () => {
    const result = assertS1([], state([storeOrder("CREATED")], [paypalOrder([])]));
    expect(result).toMatchObject({ verdict: "FAIL", reason: "The buyer's capture request is missing from the trace." });
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
    expect(result).toMatchObject({
      verdict: "PASS",
      reason:
        "The order is PAID with exactly 1 charge at PayPal. The store sent 2 capture requests to PayPal: " +
        "HTTP 500, then HTTP 201.",
    });
  });

  it("fails when the store treats the 500 as final and loses the sale", () => {
    const trace = [storeCapture(500, 2), buyerCapture(200, { status: "FAILED", message: "Payment failed." }, 3)];
    const result = assertS2(trace, state([storeOrder("FAILED")], [paypalOrder([])]));
    expect(result).toMatchObject({
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
    expect(result).toMatchObject({
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

const PAID_ANSWER = { status: "PAID", message: "Payment received. Thank you for your order." };
const FAILED_ANSWER = { status: "FAILED", message: "Payment failed. Please try again." };

describe("assertS3", () => {
  it("passes when the store asks PayPal after the timeout and the buyer checks out once", () => {
    const trace = [buyerCreate(1), storeCapture(201, 4), buyerCapture(200, PAID_ANSWER, 3)];
    const result = assertS3(trace, state([storeOrder("PAID", ORDER, 1)], [paypalOrder(["COMPLETED"])]));
    expect(result).toMatchObject({
      verdict: "PASS",
      reason: "The order is PAID with exactly 1 charge at PayPal. The buyer checked out 1 time.",
    });
  });

  it("fails when a timeout is read as a failed payment and the buyer is charged twice", () => {
    const trace = [
      buyerCreate(1),
      buyerCapture(200, FAILED_ANSWER, 3, ORDER),
      buyerCreate(6),
      buyerCapture(200, PAID_ANSWER, 8, SECOND_ORDER),
    ];
    // The first order's webhook has since made the store say PAID; the buyer was told otherwise.
    const result = assertS3(
      trace,
      state(
        [storeOrder("PAID", ORDER, 1), storeOrder("PAID", SECOND_ORDER, 1)],
        [paypalOrder(["COMPLETED"]), paypalOrder(["COMPLETED"], SECOND_ORDER)],
      ),
    );
    expect(result).toMatchObject({
      verdict: "FAIL",
      reason:
        "PayPal shows 2 charges for the cart, not 1; the store told the buyer \"Payment failed. Please try again.\" " +
        `for order ${ORDER}, which PayPal had captured. The buyer checked out 2 times.`,
    });
  });

  it("fails when PayPal captured once but the store still reports the order FAILED", () => {
    const trace = [buyerCreate(1), buyerCapture(200, FAILED_ANSWER, 3)];
    const result = assertS3(trace, state([storeOrder("FAILED")], [paypalOrder(["COMPLETED"])]));
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toContain(`the store marked order ${ORDER} FAILED`);
  });

  it("fails when nothing was captured, because the lost response was never tested", () => {
    const result = assertS3([buyerCreate(1), buyerCapture(200, FAILED_ANSWER, 3)], state([storeOrder("FAILED")], [paypalOrder([])]));
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toContain("nothing was captured");
  });
});

describe("assertS4", () => {
  it("passes when the replayed delivery does not ship the order again", () => {
    const trace = [routerDelivery(REPLAYED_DELIVERY, 200, "duplicate")];
    const result = assertS4(trace, state([storeOrder("PAID", ORDER, 1)], [paypalOrder(["COMPLETED"])]));
    expect(result).toMatchObject({
      verdict: "PASS",
      reason:
        "The order was fulfilled once although PAYMENT.CAPTURE.COMPLETED arrived twice. " +
        "The replayed PAYMENT.CAPTURE.COMPLETED got HTTP 200, outcome duplicate.",
    });
  });

  it("fails when the replayed delivery ships the order a second time", () => {
    const trace = [routerDelivery(REPLAYED_DELIVERY, 200, "applied")];
    const result = assertS4(trace, state([storeOrder("PAID", ORDER, 2)], [paypalOrder(["COMPLETED"])]));
    expect(result).toMatchObject({
      verdict: "FAIL",
      reason: `Order ${ORDER} was fulfilled 2 times. The replayed PAYMENT.CAPTURE.COMPLETED got HTTP 200, outcome applied.`,
    });
  });

  it("fails when the order was never fulfilled", () => {
    const trace = [routerDelivery(REPLAYED_DELIVERY, 400, "rejected")];
    const result = assertS4(trace, state([storeOrder("PAID", ORDER, 0)], [paypalOrder(["COMPLETED"])]));
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toMatch(/^Order 5O190127TN364715T was fulfilled 0 times\./);
  });

  it("fails when there is no replay to judge", () => {
    const result = assertS4([], state([storeOrder("PAID", ORDER, 1)], [paypalOrder(["COMPLETED"])]));
    expect(result).toMatchObject({ verdict: "FAIL", reason: "The replayed delivery is missing from the trace." });
  });
});

describe("assertS5", () => {
  const replayed = [routerDelivery(REPLAYED_DELIVERY, 200, "duplicate")];

  it("passes when the store ends REFUNDED, as PayPal reports", () => {
    const result = assertS5(replayed, state([storeOrder("REFUNDED")], [paypalOrder(["REFUNDED"])]));
    expect(result).toMatchObject({
      verdict: "PASS",
      reason:
        "The store reports the order REFUNDED, as PayPal does, although a PAYMENT.CAPTURE.COMPLETED arrived after the refund.",
    });
  });

  it("fails when the store applies the late COMPLETED and ends PAID", () => {
    const trace = [routerDelivery(REPLAYED_DELIVERY, 200, "applied")];
    const result = assertS5(trace, state([storeOrder("PAID", ORDER, 2)], [paypalOrder(["REFUNDED"])]));
    expect(result).toMatchObject({
      verdict: "FAIL",
      reason: `The store reports order ${ORDER} PAID, but PayPal reports its capture REFUNDED.`,
    });
  });

  it("fails when PayPal shows no refund, because nothing arrived out of order", () => {
    const result = assertS5(replayed, state([storeOrder("PAID")], [paypalOrder(["COMPLETED"])]));
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toContain("PayPal shows no refunded capture for the cart");
  });

  it("fails when the late event was never delivered", () => {
    const result = assertS5([], state([storeOrder("REFUNDED")], [paypalOrder(["REFUNDED"])]));
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toBe("The late PAYMENT.CAPTURE.COMPLETED is missing from the trace.");
  });
});

describe("assertS6", () => {
  const before = [storeOrder("PAID", ORDER, 1)];

  it("passes when the forged event is rejected with a 4xx and nothing changes", () => {
    const trace = [routerDelivery(FORGED_DELIVERY, 400, "rejected")];
    const result = assertS6(trace, { ...state([storeOrder("PAID", ORDER, 1)], [paypalOrder(["COMPLETED"])]), storeBefore: before });
    expect(result).toMatchObject({
      verdict: "PASS",
      reason: "The store rejected the forged event with HTTP 400, outcome rejected, and the order did not change.",
    });
  });

  it("fails when the store accepts the forged event and changes the order", () => {
    const trace = [routerDelivery(FORGED_DELIVERY, 200, "applied")];
    const result = assertS6(trace, { ...state([storeOrder("REFUNDED", ORDER, 1)], [paypalOrder(["COMPLETED"])]), storeBefore: before });
    expect(result).toMatchObject({
      verdict: "FAIL",
      reason:
        "The store answered the forged event with HTTP 200, outcome applied instead of a 4xx; " +
        `order ${ORDER} changed from PAID with 1 fulfilment to REFUNDED with 1 fulfilment.`,
    });
  });

  it("fails when the store answers 4xx but the order still changed", () => {
    const trace = [routerDelivery(FORGED_DELIVERY, 400, "rejected")];
    const result = assertS6(trace, { ...state([storeOrder("PAID", ORDER, 2)], [paypalOrder(["COMPLETED"])]), storeBefore: before });
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toContain("changed from PAID with 1 fulfilment to PAID with 2 fulfilments");
  });

  it("fails when a 5xx is used to refuse the event", () => {
    const trace = [routerDelivery(FORGED_DELIVERY, 503, "verification_unavailable")];
    const result = assertS6(trace, { ...state(before, [paypalOrder(["COMPLETED"])]), storeBefore: before });
    expect(result.verdict).toBe("FAIL");
    expect(result.reason).toContain("HTTP 503");
  });

  it("fails when there is no forged delivery or no earlier state to compare with", () => {
    expect(assertS6([], { ...state(before, []), storeBefore: before }).reason).toBe("The forged delivery is missing from the trace.");
    const trace = [routerDelivery(FORGED_DELIVERY, 400, "rejected")];
    expect(assertS6(trace, state(before, [])).reason).toBe("The store's state before the forged delivery is missing.");
  });
});

describe("inconclusiveReason", () => {
  it("names the event PayPal did not deliver and the deadline", () => {
    expect(inconclusiveReason(["PAYMENT.CAPTURE.COMPLETED"], 150_000)).toBe(
      "PayPal did not deliver PAYMENT.CAPTURE.COMPLETED within 150 s.",
    );
  });

  it("names each missing event once", () => {
    const missing = ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.COMPLETED"];
    expect(inconclusiveReason(missing, 150_000)).toBe(
      "PayPal did not deliver PAYMENT.CAPTURE.COMPLETED or PAYMENT.CAPTURE.REFUNDED within 150 s.",
    );
  });
});

describe("headlines", () => {
  const paidOnce = state([storeOrder("PAID", ORDER, 1)], [paypalOrder(["COMPLETED"])]);

  it("S1 names the protection, or how the decline went wrong", () => {
    expect(assertS1([buyerCapture(200, DECLINED_ANSWER)], state([storeOrder("DECLINED")], [paypalOrder([])])).headline).toBe(
      "Decline shown, nothing charged",
    );
    expect(assertS1([buyerCapture(200, PAID_ANSWER)], state([storeOrder("PAID")], [paypalOrder([])])).headline).toBe(
      "Declined payment marked paid",
    );
    expect(assertS1([buyerCapture(500, null)], state([storeOrder("CREATED")], [paypalOrder([])])).headline).toBe(
      "Buyer saw an error instead of a decline",
    );
  });

  it("S2 says a sale was lost only when nothing was charged", () => {
    expect(assertS2([storeCapture(500, 2)], state([storeOrder("FAILED")], [paypalOrder([])])).headline).toBe(
      "Sale lost on a transient error",
    );
    expect(assertS2([storeCapture(500, 2), storeCapture(201, 3)], paidOnce).headline).toBe("Retried and charged once");
  });

  it("S3 says the buyer was charged twice only when PayPal shows two charges", () => {
    const twice = state(
      [storeOrder("PAID", ORDER, 1), storeOrder("PAID", SECOND_ORDER, 1)],
      [paypalOrder(["COMPLETED"]), paypalOrder(["COMPLETED"], SECOND_ORDER)],
    );
    expect(assertS3([buyerCreate(1), buyerCreate(5)], twice).headline).toBe("Buyer charged twice");
    expect(assertS3([buyerCreate(1), buyerCapture(200, FAILED_ANSWER, 3)], state([storeOrder("FAILED")], [paypalOrder(["COMPLETED"])])).headline).toBe(
      "Paid order shown as failed",
    );
    expect(assertS3([buyerCreate(1)], paidOnce).headline).toBe("Charged once, no second checkout");
  });

  it("S4 counts the shipments", () => {
    const replay = [routerDelivery(REPLAYED_DELIVERY, 200, "applied")];
    expect(assertS4(replay, state([storeOrder("PAID", ORDER, 2)], [paypalOrder(["COMPLETED"])])).headline).toBe("Order shipped twice");
    expect(assertS4(replay, state([storeOrder("PAID", ORDER, 0)], [paypalOrder(["COMPLETED"])])).headline).toBe("Paid order never shipped");
    expect(assertS4(replay, paidOnce).headline).toBe("Shipped once");
  });

  it("S5 calls out a refunded order shown as paid", () => {
    const replay = [routerDelivery(REPLAYED_DELIVERY, 200, "applied")];
    expect(assertS5(replay, state([storeOrder("PAID", ORDER, 2)], [paypalOrder(["REFUNDED"])])).headline).toBe(
      "Refunded order shown as paid",
    );
    expect(assertS5(replay, state([storeOrder("REFUNDED")], [paypalOrder(["REFUNDED"])])).headline).toBe("Shows refunded, as PayPal does");
  });

  it("S6 tells an accepted forgery from a rejected one", () => {
    const before = [storeOrder("PAID", ORDER, 1)];
    const accepted = [routerDelivery(FORGED_DELIVERY, 200, "applied")];
    expect(assertS6(accepted, { ...state([storeOrder("REFUNDED", ORDER, 1)], []), storeBefore: before }).headline).toBe(
      "Forged refund accepted",
    );
    const rejected = [routerDelivery(FORGED_DELIVERY, 400, "rejected")];
    expect(assertS6(rejected, { ...state(before, []), storeBefore: before }).headline).toBe("Forged event rejected");
  });
});

describe("harms", () => {
  const paidOnce = state([storeOrder("PAID", ORDER, 1)], [paypalOrder(["COMPLETED"])]);
  const replay = [routerDelivery(REPLAYED_DELIVERY, 200, "applied")];

  it("are null for every pass", () => {
    expect(assertS1([buyerCapture(200, DECLINED_ANSWER)], state([storeOrder("DECLINED")], [paypalOrder([])])).harm).toBeNull();
    expect(assertS2([storeCapture(500, 2), storeCapture(201, 3)], paidOnce).harm).toBeNull();
    expect(assertS3([buyerCreate(1)], paidOnce).harm).toBeNull();
    expect(assertS4(replay, paidOnce).harm).toBeNull();
  });

  it("name what each failure cost, from the facts the verdict checked", () => {
    expect(assertS1([buyerCapture(200, PAID_ANSWER)], state([storeOrder("PAID")], [paypalOrder(["COMPLETED"])])).harm).toBe(
      "declined_card_charged",
    );
    expect(assertS1([buyerCapture(500, null)], state([storeOrder("CREATED")], [paypalOrder([])])).harm).toBe(
      "decline_shown_as_error",
    );
    expect(assertS2([storeCapture(500, 2)], state([storeOrder("FAILED")], [paypalOrder([])])).harm).toBe("sale_lost");
    const twice = state(
      [storeOrder("FAILED", ORDER, 1), storeOrder("PAID", SECOND_ORDER, 1)],
      [paypalOrder(["COMPLETED"]), paypalOrder(["COMPLETED"], SECOND_ORDER)],
    );
    expect(assertS3([buyerCreate(1), buyerCreate(5)], twice).harm).toBe("cart_charged_twice");
    expect(assertS4(replay, state([storeOrder("PAID", ORDER, 2)], [paypalOrder(["COMPLETED"])])).harm).toBe("order_shipped_twice");
    expect(assertS4(replay, state([storeOrder("PAID", ORDER, 3)], [paypalOrder(["COMPLETED"])])).harm).toBe(
      "order_shipped_repeatedly",
    );
    expect(assertS5(replay, state([storeOrder("PAID", ORDER, 2)], [paypalOrder(["REFUNDED"])])).harm).toBe("refund_shown_as_paid");
    const before = [storeOrder("PAID", ORDER, 1)];
    const accepted = [routerDelivery(FORGED_DELIVERY, 200, "applied")];
    expect(assertS6(accepted, { ...state([storeOrder("REFUNDED", ORDER, 1)], []), storeBefore: before }).harm).toBe(
      "forged_refund_accepted",
    );
  });

  it("claim nothing when the scenario never reached the behaviour it tests", () => {
    expect(assertS3([buyerCreate(1)], state([storeOrder("FAILED")], [paypalOrder([])])).harm).toBeNull();
    expect(assertS4([], paidOnce).harm).toBeNull();
    expect(assertS5(replay, state([storeOrder("PAID", ORDER, 1)], [paypalOrder(["COMPLETED"])])).harm).toBeNull();
    expect(assertS6([], { ...paidOnce, storeBefore: [] }).harm).toBeNull();
  });
});

describe("buyer steps under any store prefix", () => {
  /** The same trace with the buyer's store requests moved under another prefix and marked as sent to the store. */
  const under = (prefix: string, trace: TraceEntry[]): TraceEntry[] =>
    trace.map((step) =>
      step.actor === "buyer" && step.path?.startsWith("/api/store/naive")
        ? { ...step, path: step.path.replace("/api/store/naive", prefix), target: "store" as const }
        : step,
    );
  const twiceCharged = [
    buyerCreate(1),
    buyerCapture(200, FAILED_ANSWER, 3, ORDER),
    buyerCreate(6),
    buyerCapture(200, PAID_ANSWER, 8, SECOND_ORDER),
  ];
  const twice = state(
    [storeOrder("PAID", ORDER, 1), storeOrder("PAID", SECOND_ORDER, 1)],
    [paypalOrder(["COMPLETED"]), paypalOrder(["COMPLETED"], SECOND_ORDER)],
  );
  const reference = assertS3(twiceCharged, twice);

  it("keeps the reference stores' verdicts and reasons", () => {
    expect(assertS3(under("/api/store/hardened", twiceCharged), twice)).toEqual(reference);
    expect(reference.reason).toContain("The buyer checked out 2 times");
  });

  it("reads a store's own prefix the same way, a versioned /v1 API included", () => {
    for (const prefix of ["/v1", "/v2/shop", "/integration-proof", "/shop/api/v3", ""]) {
      expect(assertS3(under(prefix, twiceCharged), twice)).toEqual(reference);
    }
    const declined = [buyerCreate(1), storeCapture(422, 4), buyerCapture(200, DECLINED_ANSWER, 3)];
    const unpaid = state([storeOrder("DECLINED")], [paypalOrder([])]);
    expect(assertS1(under("/v1", declined), unpaid)).toEqual(assertS1(declined, unpaid));
  });

  it("never counts the buyer's own PayPal calls as checkouts", () => {
    const toPayPal = (seq: number, path: string, responseBody: unknown = null): TraceEntry => ({
      seq,
      actor: "buyer",
      method: "POST",
      path,
      httpStatus: 200,
      fault: null,
      responseBody,
      target: "paypal",
    });
    const trace = [
      buyerCreate(1),
      toPayPal(2, `/v2/checkout/orders/${ORDER}/confirm-payment-source`),
      // Shaped like a checkout and a capture, but sent to PayPal: neither counts.
      toPayPal(4, "/v2/checkout/orders"),
      toPayPal(5, `/v2/checkout/orders/${ORDER}/capture`, FAILED_ANSWER),
      buyerCapture(200, PAID_ANSWER, 3),
    ];
    const result = assertS3(trace, state([storeOrder("PAID", ORDER, 1)], [paypalOrder(["COMPLETED"])]));
    expect(result).toMatchObject({ verdict: "PASS", reason: "The order is PAID with exactly 1 charge at PayPal. The buyer checked out 1 time." });
  });

  it("does not take confirm-payment-source for a checkout even when the target was not recorded", () => {
    const confirm: TraceEntry = {
      seq: 2,
      actor: "buyer",
      method: "POST",
      path: `/v2/checkout/orders/${ORDER}/confirm-payment-source`,
      httpStatus: 200,
      fault: null,
      responseBody: null,
    };
    const result = assertS3([buyerCreate(1), confirm, buyerCapture(200, PAID_ANSWER, 3)], state([storeOrder("PAID", ORDER, 1)], [paypalOrder(["COMPLETED"])]));
    expect(result.reason).toContain("The buyer checked out 1 time.");
  });
});
