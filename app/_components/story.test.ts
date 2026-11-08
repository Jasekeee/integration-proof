import { describe, expect, it } from "vitest";
import type { ScenarioView, StepView } from "./report";
import { money, story } from "./story";

let seq = 0;
function step(partial: Partial<StepView>): StepView {
  seq += 1;
  return {
    id: `step-${seq}`,
    seq,
    actor: "runner",
    startedAt: "2026-11-08T04:59:30.000Z",
    durationMs: 100,
    method: null,
    path: null,
    httpStatus: null,
    debugId: null,
    paypalRequestId: null,
    fault: null,
    note: null,
    ...partial,
  };
}

function scenario(id: string, verdict: "PASS" | "FAIL", steps: StepView[]): ScenarioView {
  return {
    id,
    title: id,
    passWhen: null,
    status: "COMPLETED",
    statusLabel: "Completed",
    waitingSince: null,
    verdict,
    reason: null,
    headline: null,
    harm: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    analysis: null,
    steps,
  };
}

const order = (id: string, captures: { id: string; status: string }[]) => ({
  id,
  intent: "CAPTURE",
  status: "COMPLETED",
  purchase_units: [{ payments: { captures: captures.map((c) => ({ ...c, amount: { value: "10.00", currency_code: "USD" } })) } }],
});
const buyerCapture = (orderId: string, status: string, message: string) =>
  step({ actor: "buyer", method: "POST", path: `/api/store/naive/orders/${orderId}/capture`, httpStatus: 200, responseBody: { status, message } });
const storeCapture = (orderId: string, httpStatus: number, fault: string | null = null) =>
  step({ actor: "store", method: "POST", path: `/v2/checkout/orders/${orderId}/capture`, httpStatus, fault });
const paypalRecord = (orderId: string, captures: { id: string; status: string }[]) =>
  step({ method: "GET", path: `/v2/checkout/orders/${orderId}`, httpStatus: 200, responseBody: order(orderId, captures) });
const storeState = (orders: { status: string; fulfilments: number }[]) =>
  step({ method: "GET", path: "/api/store/naive/state?cartId=c&runId=r", httpStatus: 200, responseBody: { orders } });
const webhook = (fault: string, httpStatus: number, outcome: string) =>
  step({ method: "POST", path: "/api/store/webhooks-router", httpStatus, fault, responseBody: { outcome } });
const refund = () => step({ method: "POST", path: "/v2/payments/captures/C1/refund", httpStatus: 201, responseBody: { status: "COMPLETED" } });

const texts = (s: ReturnType<typeof story>) => s?.frames.map((frame) => frame.text + (frame.quote ? ` ${frame.quote}` : ""));

describe("money", () => {
  it("drops cents on whole dollars and keeps other currencies' codes", () => {
    expect(money(20)).toBe("$20");
    expect(money(10.5)).toBe("$10.50");
    expect(money(10, "EUR")).toBe("10 EUR");
  });
});

describe("story", () => {
  it("S3 naive: the lost answer, the store's own words, and the second charge from PayPal's record", () => {
    const told = story(
      scenario("S3", "FAIL", [
        buyerCapture("O1", "FAILED", "Payment failed. Please try again."),
        storeCapture("O1", 201, "Response held 10000 ms"),
        paypalRecord("O1", [{ id: "C1", status: "COMPLETED" }]),
        paypalRecord("O2", [{ id: "C2", status: "COMPLETED" }]),
      ]),
    );
    expect(texts(told)).toEqual([
      "PayPal took the money.",
      "The answer got lost.",
      "The store said: Payment failed. Please try again.",
      "The buyer paid again: $20 instead of $10.",
    ]);
    expect(told?.frames[3].tone).toBe("fail");
    expect(told?.short).toEqual({ did: "Guessed “failed”", got: "$20 instead of $10", tone: "fail" });
  });

  it("S3 hardened: asks PayPal and is charged once", () => {
    const told = story(
      scenario("S3", "PASS", [
        buyerCapture("O1", "PAID", "Payment received. Thank you for your order."),
        storeCapture("O1", 201, "Response held 10000 ms"),
        step({ actor: "store", method: "GET", path: "/v2/checkout/orders/O1", httpStatus: 200 }),
        paypalRecord("O1", [{ id: "C1", status: "COMPLETED" }]),
      ]),
    );
    expect(told?.short).toEqual({ did: "Asked PayPal", got: "$10, charged once", tone: "pass" });
    expect(told?.frames[2].step).toBe(told && seq - 1);
  });

  it("S1: a decline with nothing charged", () => {
    const told = story(
      scenario("S1", "PASS", [buyerCapture("O1", "DECLINED", "Your card was declined."), storeCapture("O1", 422), storeState([{ status: "DECLINED", fulfilments: 0 }])]),
    );
    expect(texts(told)?.at(-1)).toBe("Nothing was charged.");
  });

  it("S2 both ways: one try and a lost sale, or a retry and one charge", () => {
    const lost = story(
      scenario("S2", "FAIL", [buyerCapture("O1", "FAILED", "Payment failed. Please try again."), storeCapture("O1", 500), storeState([{ status: "FAILED", fulfilments: 0 }])]),
    );
    expect(lost?.short.got).toBe("sale lost");
    const paid = story(
      scenario("S2", "PASS", [
        buyerCapture("O1", "PAID", "Payment received."),
        storeCapture("O1", 500),
        storeCapture("O1", 201),
        paypalRecord("O1", [{ id: "C1", status: "COMPLETED" }]),
        storeState([{ status: "PAID", fulfilments: 1 }]),
      ]),
    );
    expect(paid?.short).toEqual({ did: "Tried again", got: "$10 paid", tone: "pass" });
  });

  it("S4 both ways, from the replay's outcome and the fulfilment count", () => {
    const base = () => [storeCapture("O1", 201), paypalRecord("O1", [{ id: "C1", status: "COMPLETED" }])];
    const twice = story(scenario("S4", "FAIL", [...base(), webhook("Replayed PayPal delivery", 200, "applied"), storeState([{ status: "PAID", fulfilments: 2 }])]));
    expect(twice?.short.got).toBe("shipped twice");
    const once = story(scenario("S4", "PASS", [...base(), webhook("Replayed PayPal delivery", 200, "duplicate"), storeState([{ status: "PAID", fulfilments: 1 }])]));
    expect(once?.short.got).toBe("shipped once");
  });

  it("S5: the store's status against PayPal's refunded capture", () => {
    const base = () => [storeCapture("O1", 201), refund(), paypalRecord("O1", [{ id: "C1", status: "REFUNDED" }])];
    const wrong = story(scenario("S5", "FAIL", [...base(), webhook("Replayed PayPal delivery", 200, "applied"), storeState([{ status: "PAID", fulfilments: 2 }])]));
    expect(wrong?.frames.at(-1)?.text).toBe("The store says Paid. PayPal says Refunded.");
    const right = story(scenario("S5", "PASS", [...base(), webhook("Replayed PayPal delivery", 200, "duplicate"), storeState([{ status: "REFUNDED", fulfilments: 1 }])]));
    expect(right?.short.did).toBe("Ignored the old notice");
  });

  it("S6: a forged refund applied, or rejected with a 4xx and the order unchanged", () => {
    const base = () => [storeCapture("O1", 201), paypalRecord("O1", [{ id: "C1", status: "COMPLETED" }]), storeState([{ status: "PAID", fulfilments: 1 }])];
    const forged = "Forged delivery: body changed after PayPal signed it";
    const applied = story(scenario("S6", "FAIL", [...base(), webhook(forged, 200, "applied"), storeState([{ status: "REFUNDED", fulfilments: 1 }])]));
    expect(applied?.frames.at(-1)?.text).toBe("A paid order now shows Refunded.");
    const rejected = story(scenario("S6", "PASS", [...base(), webhook(forged, 400, "rejected"), storeState([{ status: "PAID", fulfilments: 1 }])]));
    expect(rejected?.short).toEqual({ did: "Checked PayPal’s signature", got: "rejected", tone: "pass" });
  });

  it("tells nothing when a fact is missing, the verdict is open, or the facts contradict the verdict", () => {
    // No record from PayPal: the charges cannot be counted.
    expect(story(scenario("S3", "FAIL", [buyerCapture("O1", "FAILED", "Payment failed."), storeCapture("O1", 201, "Response held 10000 ms")]))).toBeNull();
    const steps = [
      buyerCapture("O1", "FAILED", "Payment failed."),
      storeCapture("O1", 201, "Response held 10000 ms"),
      paypalRecord("O1", [{ id: "C1", status: "COMPLETED" }]),
      paypalRecord("O2", [{ id: "C2", status: "COMPLETED" }]),
    ];
    expect(story({ ...scenario("S3", "FAIL", steps), verdict: null, status: "RUNNING" })).toBeNull();
    expect(story(scenario("S3", "PASS", steps))).toBeNull();
    expect(story(null)).toBeNull();
  });
});
