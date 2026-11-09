// What the checkout page shows after the buyer approves in PayPal: the store's capture call, and the
// one decision of what the buyer sees next. Kept out of the component so every outcome is tested.
import { z } from "zod";
import type { Mode } from "../../_components/report";

const CapturedSchema = z.object({ status: z.string(), captureId: z.string().nullable(), message: z.string() });
const ErrorSchema = z.object({ message: z.string() });

/**
 * The store's answer to the capture: a 2xx with the order's status, or no usable answer at all
 * (a network error, a non-2xx, a body that is not the store's).
 */
export type CaptureAnswer =
  | { kind: "answered"; status: string; captureId: string | null; message: string }
  | { kind: "failed"; message: string };

/** The store captures the approved order. Never throws: a failure is an answer too. */
export async function requestCapture(mode: Mode, orderId: string, fetchImpl: typeof fetch = fetch): Promise<CaptureAnswer> {
  const response = await fetchImpl(`/api/store/${mode}/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST" }).catch(
    () => null,
  );
  if (!response) return { kind: "failed", message: "The store could not be reached." };
  const body: unknown = await response.json().catch(() => null);
  const captured = CapturedSchema.safeParse(body);
  if (response.ok && captured.success) return { kind: "answered", ...captured.data };
  return {
    kind: "failed",
    message: ErrorSchema.safeParse(body).data?.message ?? `The store could not capture the order (HTTP ${response.status}).`,
  };
}

/** The capture with the page's flag around it: set while the call runs, cleared whatever happens. */
export async function captureWithFlag(
  mode: Mode,
  orderId: string,
  setCapturing: (capturing: boolean) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<CaptureAnswer> {
  setCapturing(true);
  try {
    return await requestCapture(mode, orderId, fetchImpl);
  } finally {
    setCapturing(false);
  }
}

/** The cart's order as the store's state reports it. */
export interface CartOrder {
  status: string;
  captureId: string | null;
}

/**
 * Whether PayPal itself confirmed that nothing was captured. A decline is PayPal's answer in both
 * stores. The hardened store reports FAILED only when PayPal refused the capture or its order shows
 * none; the naive store reports FAILED without asking PayPal, so its FAILED confirms nothing.
 */
function confirmedNotCaptured(mode: Mode, status: string | undefined): boolean {
  return status === "DECLINED" || (status === "FAILED" && mode === "hardened");
}

/** Whether the page should follow the cart's state after this answer: unless PayPal confirmed there is nothing to follow. */
export function followsCart(mode: Mode, answer: CaptureAnswer): boolean {
  return !(answer.kind === "answered" && confirmedNotCaptured(mode, answer.status));
}

export const NOT_CHARGED = "Payment didn't go through. You were not charged.";
export const DID_NOT_GO_THROUGH = "Payment didn't go through.";

export type CheckoutView =
  | { kind: "ready" }
  | { kind: "capturing" }
  | { kind: "loading" }
  | { kind: "checking" }
  | { kind: "paid"; captureId: string | null }
  | { kind: "not_charged"; message: typeof NOT_CHARGED }
  | { kind: "failed"; message: typeof DID_NOT_GO_THROUGH }
  | { kind: "unpaid" };

/**
 * What the buyer sees in place of, or with, PayPal's buttons. A capture seen anywhere (the store's
 * answer, its state, PayPal's COMPLETED webhook) is a receipt. "You were not charged" only when
 * PayPal confirmed it. An outcome nobody confirmed is followed through the cart's state, buttons
 * hidden, so a buyer whose payment did go through is never offered a second one; when that ends
 * without a capture, the buttons come back.
 */
export function checkoutView(input: {
  mode: Mode;
  answer: CaptureAnswer | null;
  order: CartOrder | null;
  webhookCompleted: boolean;
  stateLoaded: boolean;
  following: boolean;
  capturing: boolean;
  /** Opened from a ?cart= link: it shows that cart, never a payment button. */
  sharedLink: boolean;
}): CheckoutView {
  const { mode, answer, order, webhookCompleted, stateLoaded, following, capturing, sharedLink } = input;
  const answered = answer?.kind === "answered" ? answer : null;
  if ((answered && answered.status === "PAID") || order?.captureId || webhookCompleted) {
    return { kind: "paid", captureId: answered?.captureId ?? order?.captureId ?? null };
  }
  if (capturing) return { kind: "capturing" };
  if (sharedLink && !stateLoaded) return { kind: "loading" };
  const status = answered ? answered.status : stateLoaded ? order?.status : undefined;
  if (confirmedNotCaptured(mode, status)) return { kind: "not_charged", message: NOT_CHARGED };
  if (answer && (following || !stateLoaded)) return { kind: "checking" };
  if (answer) return { kind: "failed", message: DID_NOT_GO_THROUGH };
  if (sharedLink) return { kind: "unpaid" };
  return { kind: "ready" };
}

/** PayPal's buttons show only where a new payment cannot follow one that went through. */
export function showsButtons(view: CheckoutView, sharedLink: boolean): boolean {
  return !sharedLink && (view.kind === "ready" || view.kind === "not_charged" || view.kind === "failed");
}
