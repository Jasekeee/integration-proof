import { describe, expect, it, vi } from "vitest";
import type { Mode } from "../../_components/report";
import {
  captureWithFlag,
  checkoutView,
  DID_NOT_GO_THROUGH,
  followsCart,
  NOT_CHARGED,
  requestCapture,
  showsButtons,
  type CaptureAnswer,
  type CartOrder,
} from "./capture";

/** A capture call that answers with this status and body, as the store's route would. */
function answers(status: number, body: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}
const unreachable: typeof fetch = vi.fn(async () => {
  throw new TypeError("Failed to fetch");
});
const notJson: typeof fetch = vi.fn(async () => new Response("<html>Bad gateway</html>", { status: 502 }));

const paid = { orderId: "5O190127TN364715T", status: "PAID", captureId: "3C679366HH908993F", message: "Payment received. Thank you for your order." };
const declined = { orderId: "5O190127TN364715T", status: "DECLINED", captureId: null, message: "Your card was declined. Try another card or payment method." };
const failed = { orderId: "5O190127TN364715T", status: "FAILED", captureId: null, message: "Payment failed. Please try again." };
const pending = { orderId: "5O190127TN364715T", status: "PENDING", captureId: null, message: "We are confirming your payment with PayPal." };

/** The page right after the capture call, before the cart's state has been read. */
function afterCall(mode: Mode, answer: CaptureAnswer) {
  return { mode, answer, order: null, webhookCompleted: false, stateLoaded: false, following: followsCart(mode, answer), capturing: false, sharedLink: false };
}

/** Every outcome of the capture call: the stubbed response, the answer it becomes, and what the buyer sees next. */
const OUTCOMES: { name: string; mode: Mode; call: typeof fetch; answer: CaptureAnswer["kind"]; next: string; buttons: boolean }[] = [
  { name: "PAID", mode: "hardened", call: answers(200, paid), answer: "answered", next: "paid", buttons: false },
  { name: "DECLINED", mode: "hardened", call: answers(200, declined), answer: "answered", next: "not_charged", buttons: true },
  { name: "DECLINED, naive store", mode: "naive", call: answers(200, declined), answer: "answered", next: "not_charged", buttons: true },
  { name: "FAILED, hardened store", mode: "hardened", call: answers(200, failed), answer: "answered", next: "not_charged", buttons: true },
  { name: "FAILED, naive store", mode: "naive", call: answers(200, failed), answer: "answered", next: "checking", buttons: false },
  { name: "PENDING", mode: "hardened", call: answers(200, pending), answer: "answered", next: "checking", buttons: false },
  { name: "HTTP 500 with the store's error", mode: "hardened", call: answers(500, { message: "PayPal could not be reached." }), answer: "failed", next: "checking", buttons: false },
  { name: "HTTP 404", mode: "hardened", call: answers(404, { message: "No such order in this store." }), answer: "failed", next: "checking", buttons: false },
  { name: "HTTP 502, not JSON", mode: "hardened", call: notJson, answer: "failed", next: "checking", buttons: false },
  { name: "HTTP 200, not the store's body", mode: "hardened", call: answers(200, { ok: true }), answer: "failed", next: "checking", buttons: false },
  { name: "network error", mode: "hardened", call: unreachable, answer: "failed", next: "checking", buttons: false },
];

describe("the capture call", () => {
  it.each(OUTCOMES)("$name: the flag is set, then cleared; the call never throws", async ({ mode, call, answer }) => {
    const flag = vi.fn();
    const result = await captureWithFlag(mode, "5O190127TN364715T", flag, call);
    expect(flag.mock.calls).toEqual([[true], [false]]);
    expect(result.kind).toBe(answer);
  });

  it("calls the store's capture route for the order", async () => {
    const call = answers(200, paid);
    await requestCapture("hardened", "5O190127TN364715T", call);
    expect(call).toHaveBeenCalledWith("/api/store/hardened/orders/5O190127TN364715T/capture", { method: "POST" });
  });

  it("keeps the store's own words when it answers with an error", async () => {
    expect(await requestCapture("hardened", "X", answers(500, { message: "PayPal could not be reached." }))).toEqual({
      kind: "failed",
      message: "PayPal could not be reached.",
    });
    expect(await requestCapture("hardened", "X", notJson)).toEqual({ kind: "failed", message: "The store could not capture the order (HTTP 502)." });
    expect(await requestCapture("hardened", "X", unreachable)).toEqual({ kind: "failed", message: "The store could not be reached." });
  });
});

describe("what the buyer sees right after the call", () => {
  it.each(OUTCOMES)("$name → $next", async ({ mode, call, next, buttons }) => {
    const answer = await requestCapture(mode, "5O190127TN364715T", call);
    const view = checkoutView(afterCall(mode, answer));
    expect(view.kind).toBe(next);
    expect(showsButtons(view, false)).toBe(buttons);
  });

  it("says 'You were not charged' only when PayPal confirmed it", async () => {
    for (const { mode, call } of OUTCOMES) {
      const answer = await requestCapture(mode, "5O190127TN364715T", call);
      const view = checkoutView(afterCall(mode, answer));
      const confirmed = answer.kind === "answered" && (answer.status === "DECLINED" || (answer.status === "FAILED" && mode === "hardened"));
      expect(view.kind === "not_charged" && view.message === NOT_CHARGED).toBe(confirmed);
    }
  });

  it("is never mid-capture once the flag is cleared, and hides the buttons while it is set", () => {
    const capturing = checkoutView({ ...afterCall("hardened", { kind: "failed", message: "x" }), answer: null, capturing: true });
    expect(capturing.kind).toBe("capturing");
    expect(showsButtons(capturing, false)).toBe(false);
  });
});

describe("an outcome nobody confirmed, settled by the cart's state", () => {
  const unconfirmed: [string, Mode, CaptureAnswer][] = [
    ["a network error", "hardened", { kind: "failed", message: "The store could not be reached." }],
    ["a non-2xx", "hardened", { kind: "failed", message: "The store could not capture the order (HTTP 500)." }],
    ["the naive store's FAILED", "naive", { kind: "answered", ...failed }],
    ["PENDING", "hardened", { kind: "answered", ...pending }],
  ];
  const captured: CartOrder = { status: "PAID", captureId: "3C679366HH908993F" };

  it.each(unconfirmed)("%s, then the state shows a capture: the receipt, no buttons", (_name, mode, answer) => {
    const view = checkoutView({ ...afterCall(mode, answer), order: captured, stateLoaded: true, following: true });
    expect(view).toEqual({ kind: "paid", captureId: answer.kind === "answered" ? (answer.captureId ?? captured.captureId) : captured.captureId });
    expect(showsButtons(view, false)).toBe(false);
  });

  it.each(unconfirmed)("%s, then PayPal's COMPLETED webhook: the receipt", (_name, mode, answer) => {
    const view = checkoutView({ ...afterCall(mode, answer), order: { status: "FAILED", captureId: null }, webhookCompleted: true, stateLoaded: true });
    expect(view.kind).toBe("paid");
  });

  it.each(unconfirmed)("%s, still being followed: checking, buttons hidden", (_name, mode, answer) => {
    const view = checkoutView({ ...afterCall(mode, answer), order: { status: "CREATED", captureId: null }, stateLoaded: true, following: true });
    expect(view.kind).toBe("checking");
    expect(showsButtons(view, false)).toBe(false);
  });

  it.each(unconfirmed)("%s, and the wait ends with no capture: the buttons come back, no promise about the charge", (_name, mode, answer) => {
    const view = checkoutView({ ...afterCall(mode, answer), order: { status: "CREATED", captureId: null }, stateLoaded: true, following: false });
    expect(view).toEqual({ kind: "failed", message: DID_NOT_GO_THROUGH });
    expect(showsButtons(view, false)).toBe(true);
  });

  it("a network error after which the hardened store's state shows FAILED: PayPal confirmed it, not charged", () => {
    const view = checkoutView({
      ...afterCall("hardened", { kind: "failed", message: "x" }),
      order: { status: "FAILED", captureId: null },
      stateLoaded: true,
      following: true,
    });
    expect(view).toEqual({ kind: "not_charged", message: NOT_CHARGED });
    expect(showsButtons(view, false)).toBe(true);
  });

  it("the same with the naive store: its FAILED confirms nothing", () => {
    const view = checkoutView({ ...afterCall("naive", { kind: "failed", message: "x" }), order: { status: "FAILED", captureId: null }, stateLoaded: true, following: true });
    expect(view.kind).toBe("checking");
  });
});

describe("followsCart", () => {
  it("stops only where PayPal confirmed nothing was captured", () => {
    expect(followsCart("hardened", { kind: "answered", ...paid })).toBe(true);
    expect(followsCart("hardened", { kind: "answered", ...declined })).toBe(false);
    expect(followsCart("hardened", { kind: "answered", ...failed })).toBe(false);
    expect(followsCart("naive", { kind: "answered", ...failed })).toBe(true);
    expect(followsCart("hardened", { kind: "answered", ...pending })).toBe(true);
    expect(followsCart("hardened", { kind: "failed", message: "x" })).toBe(true);
  });
});

describe("a shared ?cart= link", () => {
  const shared = { mode: "hardened" as Mode, answer: null, webhookCompleted: false, following: true, capturing: false, sharedLink: true };

  it("never shows a payment button, whatever the cart", () => {
    const views = [
      checkoutView({ ...shared, order: null, stateLoaded: false }),
      checkoutView({ ...shared, order: { status: "PAID", captureId: "3C679366HH908993F" }, stateLoaded: true }),
      checkoutView({ ...shared, order: { status: "DECLINED", captureId: null }, stateLoaded: true }),
      checkoutView({ ...shared, order: { status: "CREATED", captureId: null }, stateLoaded: true, following: false }),
    ];
    expect(views.map((view) => view.kind)).toEqual(["loading", "paid", "not_charged", "unpaid"]);
    for (const view of views) expect(showsButtons(view, true)).toBe(false);
  });
});
