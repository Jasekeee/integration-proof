"use client";

// A real PayPal Checkout with the JS SDK v6, following developer.paypal.com/guides/nextjs-checkout.
// The buttons call the store's own routes, /api/store/[mode]/orders and .../capture, which run the
// same createOrder and captureOrder as the proof runner's headless buyer. Afterwards the page reads
// the store's state for the cart until PayPal's webhook has been applied.
import {
  PayPalGuestPaymentButton,
  PayPalOneTimePaymentButton,
  PayPalProvider,
  type OnApproveDataOneTimePayments,
} from "@paypal/react-paypal-js/sdk-v6";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import type { Mode } from "../../_components/report";
import { TraceText } from "../../_components/trace-text";
import { buttonSecondary, linkUtility, panel, panelLabel } from "../../_components/ui";
import { captureWithFlag, checkoutView, followsCart, showsButtons, type CaptureAnswer, type CheckoutView } from "./capture";

const POLL_MS = 3000;
/** The proof waits as long for a webhook (WEBHOOK_WAIT_MS); recorded deliveries took 4 to 133 s, most under a minute. */
const WEBHOOK_WAIT_MS = 150_000;
const COMPLETED = "PAYMENT.CAPTURE.COMPLETED";

const CreatedSchema = z.object({ orderId: z.string() });
const ErrorSchema = z.object({ message: z.string() });
const StateSchema = z.object({
  orders: z.array(
    z.object({
      paypalOrderId: z.string(),
      status: z.string(),
      captureId: z.string().nullable(),
      fulfilments: z.number(),
      createdAt: z.string(),
    }),
  ),
  deliveries: z.array(
    z.object({
      receivedAt: z.string(),
      eventId: z.string().nullable(),
      eventType: z.string().nullable(),
      verification: z.string(),
      outcome: z.string(),
      responseStatus: z.number(),
    }),
  ),
});
type StoreState = z.infer<typeof StateSchema>;

type Phase =
  | { kind: "ready" }
  | { kind: "paying" }
  | { kind: "error"; message: string };

function newCartId(): string {
  return `manual-${crypto.randomUUID()}`;
}

async function readError(response: Response, fallback: string): Promise<string> {
  return ErrorSchema.safeParse(await response.json().catch(() => null)).data?.message ?? `${fallback} (HTTP ${response.status}).`;
}

function delivered(state: StoreState | null): boolean {
  if (!state) return false;
  const acknowledged = state.deliveries.some(
    (delivery) => delivery.eventType === COMPLETED && delivery.responseStatus >= 200 && delivery.responseStatus < 300,
  );
  return acknowledged && state.orders.some((order) => order.fulfilments > 0);
}

export function Checkout({
  mode,
  storeName,
  clientId,
  buyerEmail,
  product,
  testCard,
  initialCart,
}: {
  mode: Mode;
  /** The store's name, as the site writes it: "Hardened store". */
  storeName: string;
  clientId: string | null;
  buyerEmail: string | null;
  product: { description: string; amount: { currency_code: string; value: string } };
  testCard: { number: string; expiry: string; securityCode: string };
  initialCart: string | null;
}) {
  const [cartId, setCartId] = useState<string | null>(initialCart);
  const cartRef = useRef<string | null>(initialCart);
  const [phase, setPhase] = useState<Phase>({ kind: "ready" });
  const [state, setState] = useState<StoreState | null>(null);
  // A shared transaction link starts following the cart at once.
  const [polling, setPolling] = useState<{ since: number } | null>(() => (initialCart ? { since: Date.now() } : null));
  const [now, setNow] = useState(() => Date.now());
  /** The store is capturing: the buyer approved in PayPal and the capture has not answered yet. */
  const [capturing, setCapturing] = useState(false);
  /** The store's answer to this page's capture, or no usable answer; null before one. */
  const [answer, setAnswer] = useState<CaptureAnswer | null>(null);

  /** The store creates the order; the SDK opens PayPal with its id. */
  const createOrder = useCallback(async (): Promise<{ orderId: string }> => {
    const cart = newCartId();
    cartRef.current = cart;
    setCartId(cart);
    setState(null);
    setAnswer(null);
    setPolling(null);
    setPhase({ kind: "paying" });
    const response = await fetch(`/api/store/${mode}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cartId: cart }),
    });
    const body = CreatedSchema.safeParse(await response.clone().json().catch(() => null));
    if (response.status !== 201 || !body.success) {
      const message = await readError(response, "The store could not create the order");
      setPhase({ kind: "error", message });
      throw new Error(message);
    }
    return { orderId: body.data.orderId };
  }, [mode]);

  /** The buyer approved in PayPal; the store captures, as it does for the runner. */
  const onApprove = useCallback(
    async ({ orderId }: OnApproveDataOneTimePayments) => {
      // The flag is cleared whatever happens, and the call never throws: a failure is an answer.
      const result = await captureWithFlag(mode, orderId, setCapturing);
      setAnswer(result);
      setPhase({ kind: "ready" });
      if (result.kind === "answered" && cartRef.current) window.history.replaceState(null, "", `?cart=${cartRef.current}`);
      // Unless PayPal confirmed nothing was captured, the cart's state settles it: a capture, or PayPal's webhook.
      if (followsCart(mode, result)) setPolling({ since: Date.now() });
    },
    [mode],
  );

  const onCancel = useCallback(() => setPhase({ kind: "ready" }), []);
  const onError = useCallback((error: { message?: string }) => {
    setPhase({ kind: "error", message: `PayPal reported an error: ${error.message ?? "unknown error"}.` });
  }, []);

  // The store's view of the cart, until the webhook has been applied or the wait is over.
  useEffect(() => {
    if (!polling || !cartId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const response = await fetch(`/api/store/${mode}/state?cartId=${encodeURIComponent(cartId)}`, { cache: "no-store" }).catch(() => null);
      const parsed = response?.ok ? StateSchema.safeParse(await response.json().catch(() => null)) : null;
      if (cancelled) return;
      if (parsed?.success) setState(parsed.data);
      setNow(Date.now());
      const done = parsed?.success && delivered(parsed.data);
      if (!done && Date.now() - polling.since < WEBHOOK_WAIT_MS) timer = setTimeout(poll, POLL_MS);
      else setPolling(null);
    };
    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [polling, cartId, mode]);

  const order = state?.orders[0] ?? null;
  const shareUrl = cartId && (answer?.kind === "answered" || initialCart) ? `/store/${mode}?cart=${cartId}` : null;
  const components = useMemo(() => ["paypal-payments", "paypal-guest-payments"] as const, []);
  const webhook = state?.deliveries.find((delivery) => delivery.eventType === COMPLETED) ?? null;
  const fulfilled = order && delivered(state) ? order : null;
  const capturedOrder = state?.orders.find((candidate) => candidate.captureId !== null) ?? null;
  // One decision of what the buyer sees (./capture.ts): a receipt once a capture is seen anywhere, so
  // a paid cart never shows a payment button again; PayPal's buttons back only where a new payment
  // cannot follow one that went through.
  const view = checkoutView({
    mode,
    answer,
    order: capturedOrder ?? order,
    webhookCompleted: delivered(state) || Boolean(webhook && webhook.responseStatus >= 200 && webhook.responseStatus < 300),
    stateLoaded: state !== null,
    following: Boolean(polling),
    capturing,
    sharedLink: Boolean(initialCart),
  });
  const showButtons = showsButtons(view, Boolean(initialCart));
  const answered = answer?.kind === "answered" ? answer : null;
  const total = `${product.amount.value} ${product.amount.currency_code}`;

  return (
    // Panels on a surface, like a scenario's scene on /proof: the order with its total and PayPal's
    // buttons on the left, the sandbox's testing details, quieter, on the right, and below them what
    // the store and PayPal did. On a phone the order comes first.
    <div className="flex flex-col gap-3 rounded-panel bg-surface p-3 sm:gap-4 sm:p-4">
      {/* Each card is as tall as its content, so nothing stretches into an empty area. */}
      <div className="grid gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:items-start">
        <section className={`flex min-w-0 flex-col gap-5 ${panel}`} aria-labelledby="buy">
          <div className="flex flex-col gap-1">
            <h2 id="buy" className="text-xl font-medium leading-snug tracking-tight">
              Your order
            </h2>
            <p className={panelLabel}>{storeName}</p>
          </div>

          <dl className="flex flex-col text-base">
            <div className="flex items-baseline justify-between gap-4 border-b border-border pb-3">
              <dt>
                {product.description} <span className="text-muted">· qty 1</span>
              </dt>
              <dd className="shrink-0 tabular-nums">{total}</dd>
            </div>
            <div className="flex items-baseline justify-between gap-4 pt-3 text-lg font-semibold">
              <dt>Total</dt>
              <dd className="shrink-0 tabular-nums">{total}</dd>
            </div>
          </dl>

          {clientId ? (
            <PayPalProvider clientId={clientId} environment="sandbox" components={[...components]} pageType="checkout">
              {/* Hidden, never removed, once the cart is paid or being captured: the SDK keeps its elements. */}
              <div hidden={!showButtons}>
                {/* Holds the two buttons' height (45 px each and the gap) while the SDK draws them, so the page does not move.
                    The SDK's elements take the card's full width from here; their props and loading are untouched. */}
                <div
                  className="flex min-h-[102px] flex-col gap-3 [&>*]:w-full [&_paypal-basic-card-button]:w-full"
                  aria-busy={phase.kind === "paying"}
                >
                  <PayPalOneTimePaymentButton
                    createOrder={createOrder}
                    onApprove={onApprove}
                    onCancel={onCancel}
                    onError={onError}
                    presentationMode="auto"
                  />
                  <PayPalGuestPaymentButton createOrder={createOrder} onApprove={onApprove} onCancel={onCancel} onError={onError} />
                </div>
              </div>
            </PayPalProvider>
          ) : (
            <p role="alert" className="rounded-control border border-warn/40 bg-warn-bg p-3 text-sm text-warn">
              The PayPal client id is not configured, so the buttons cannot load.
            </p>
          )}

          <Receipt mode={mode} total={total} view={view} sharedLink={Boolean(initialCart)} />

          {phase.kind === "error" && (
            <p role="alert" className="rounded-control border border-fail/40 bg-fail-bg p-3 text-sm text-fail">
              {phase.message}
            </p>
          )}
        </section>

        <section className="flex min-w-0 flex-col gap-5 rounded-panel border border-border p-5 text-sm leading-6 sm:p-6" aria-labelledby="testing">
          <h2 id="testing" className="text-base font-medium">
            Testing in the PayPal sandbox
          </h2>
          <div className="flex flex-col gap-1">
            <p className="font-medium">Pay with PayPal</p>
            <p className="text-pretty text-muted">
              Log in as the sandbox buyer
              {buyerEmail ? (
                <>
                  {" "}
                  <span className="break-all font-mono text-foreground">{buyerEmail}</span>
                </>
              ) : null}
              . Reviewers get the sandbox buyer password with the testing instructions.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <p className="font-medium">Or pay by card</p>
            <p className="text-pretty text-muted">Choose Debit or Credit Card and enter PayPal&apos;s published sandbox test card:</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
              <dt className="text-muted">Card</dt>
              <dd className="font-mono tabular-nums">{testCard.number.replace(/(\d{4})(?=\d)/g, "$1 ")}</dd>
              <dt className="text-muted">Expiry</dt>
              <dd className="font-mono tabular-nums">{testCard.expiry.split("-").reverse().join("/")}</dd>
              <dt className="text-muted">CVV</dt>
              <dd className="font-mono tabular-nums">{testCard.securityCode}</dd>
            </dl>
          </div>
          <p className="text-muted">Sandbox only: no real money moves.</p>
        </section>
      </div>

      <section className={`flex min-w-0 flex-col gap-4 ${panel}`} aria-labelledby="result" aria-live="polite">
        <h2 id="result" className={panelLabel}>
          What the store and PayPal did
        </h2>
        <ol className="grid gap-2 sm:gap-3 md:grid-cols-3">
          <Stage
            label="The store takes the payment"
            done={view.kind === "paid"}
            failed={view.kind === "not_charged" || view.kind === "failed"}
            text={
              answered
                ? `${answered.status} · ${answered.message}`
                : view.kind === "paid"
                  ? `${capturedOrder?.status ?? "PAID"} · capture ${view.captureId}`
                  : answer
                    ? answer.message
                    : capturing
                      ? "Capturing the payment…"
                      : view.kind === "unpaid"
                        ? "Not paid"
                        : phase.kind === "paying"
                          ? "Paying in PayPal…"
                          : "Waiting for you to pay"
            }
          />
          <Stage
            label="PayPal's webhook arrives"
            done={Boolean(webhook)}
            text={
              webhook
                ? `Signature ${webhook.verification}`
                : polling
                  ? `Waiting · ${Math.round((now - polling.since) / 1000)} s of ${WEBHOOK_WAIT_MS / 1000} s`
                  : view.kind === "not_charged"
                    ? "None: nothing was captured"
                    : cartId && order
                    ? `Not applied within ${WEBHOOK_WAIT_MS / 1000} s. PayPal delivers to the deployed service only, and deliveries can take a while; reload this page later.`
                    : "After the payment, usually within a minute"
            }
            detail={webhook ? `${webhook.eventType ?? "event"}, ${webhook.outcome}` : null}
          />
          <Stage
            label="The order is fulfilled"
            done={Boolean(fulfilled)}
            text={fulfilled ? `${fulfilled.status} · fulfilled ${fulfilled.fulfilments === 1 ? "once" : `${fulfilled.fulfilments} times`}` : "When the webhook is applied"}
          />
        </ol>

        {cartId && state && <TransactionTrace mode={mode} state={state} />}

        {shareUrl && (
          <p className="text-sm text-muted">
            This transaction:{" "}
            <a href={shareUrl} className={`break-all rounded-sm font-mono text-xs ${linkUtility}`}>
              {shareUrl}
            </a>
          </p>
        )}
      </section>
    </div>
  );
}

/**
 * With or in place of PayPal's buttons: the receipt once the cart is paid, what is happening while
 * the store captures or the page checks with PayPal, and why a payment did not go through. A new
 * checkout loads the plain page, so it opens a new cart.
 */
function Receipt({ mode, total, view, sharedLink }: { mode: Mode; total: string; view: CheckoutView; sharedLink: boolean }) {
  const again = (
    <a href={`/store/${mode}`} className={`${buttonSecondary} self-start`}>
      Start a new checkout
    </a>
  );
  if (view.kind === "ready") return null;
  if (view.kind === "paid") {
    return (
      <div role="status" className="flex flex-col gap-3 rounded-card bg-pass-bg p-4 sm:p-5">
        <p className="flex items-center gap-2 text-lg font-semibold text-pass">
          {check}
          Paid {total}
        </p>
        {view.captureId && (
          <p className="text-sm text-muted">
            Capture <span className="break-all font-mono text-foreground">{view.captureId}</span>
          </p>
        )}
        {again}
      </div>
    );
  }
  // The buttons are back above it; on a shared link a new checkout is the way to pay again.
  if (view.kind === "not_charged" || view.kind === "failed") {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-card bg-fail-bg p-4 text-fail sm:p-5">
        <p className="font-medium">{view.message}</p>
        {sharedLink && again}
      </div>
    );
  }
  return (
    <div role="status" className="flex min-h-[102px] flex-col justify-center gap-3 rounded-card bg-surface p-4 sm:p-5">
      {view.kind === "unpaid" ? (
        <>
          <p className="text-sm text-muted">This cart was not paid.</p>
          {again}
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted">
          <span aria-hidden="true" className="spinner" />
          {view.kind === "capturing"
            ? "The store is capturing the payment…"
            : view.kind === "checking"
              ? "Checking with PayPal whether the payment went through…"
              : "Loading this order…"}
        </p>
      )}
    </div>
  );
}

const check = (
  <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0 text-pass">
    <path d="m3.5 8.4 2.8 2.8 6.2-6.6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** One stage of the purchase, a frame like a scene's: what it is, and what has happened so far. */
function Stage({
  label,
  done,
  failed = false,
  text,
  detail = null,
}: {
  label: string;
  done: boolean;
  /** The stage ended without a payment: it reads in the failure color, never green. */
  failed?: boolean;
  text: string;
  detail?: string | null;
}) {
  return (
    <li className={`flex min-w-0 flex-col gap-2 rounded-card px-4 py-3 ${done ? "bg-pass-bg" : failed ? "bg-fail-bg" : "bg-surface"}`}>
      <p className="flex items-center gap-2 text-small text-muted">
        {done && check}
        {label}
        {done && <span className="sr-only">: done</span>}
      </p>
      <p
        className={`text-base font-medium leading-snug text-pretty tabular-nums ${done ? "text-pass" : failed ? "text-fail" : "text-foreground"}`}
        suppressHydrationWarning
      >
        {text}
      </p>
      {detail && <p className="break-words text-xs text-muted">{detail}</p>}
    </li>
  );
}

/** One step of the trace: five columns from 640 px, stacked lines on a phone. */
const TRACE_ROW =
  "grid gap-x-4 gap-y-1 px-3 py-2 sm:grid-cols-[1.5rem_3.5rem_minmax(0,1.6fr)_5.5rem_minmax(0,1fr)] sm:items-baseline";

/** The cart's order and webhook deliveries as the store recorded them, step by step. */
function TransactionTrace({ mode, state }: { mode: Mode; state: StoreState }) {
  const rows = state.orders.flatMap((order) => [
    { actor: "store", call: "POST /v2/checkout/orders", status: "201", detail: `order ${order.paypalOrderId} created` },
    {
      actor: "store",
      call: `POST /v2/checkout/orders/${order.paypalOrderId}/capture`,
      status: order.captureId ? "COMPLETED" : "–",
      detail: order.captureId ? `capture ${order.captureId}` : "no capture recorded",
    },
  ]);
  for (const delivery of state.deliveries) {
    rows.push({
      actor: "PayPal",
      call: `webhook ${delivery.eventType ?? "event"}`,
      status: String(delivery.responseStatus),
      detail: `${mode} store: ${delivery.outcome}, signature ${delivery.verification}`,
    });
  }
  for (const order of state.orders) {
    rows.push({ actor: "store", call: "state", status: order.status, detail: `fulfilments ${order.fulfilments}` });
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className={panelLabel}>Trace of this payment</p>
      {/* A table from 640 px; on a phone each step stacks into lines, so nothing is cut off. */}
      <div className="rounded-control border border-border text-xs">
        <div aria-hidden="true" className={`${TRACE_ROW} bg-surface-2 font-medium text-muted max-sm:hidden`}>
          <span>#</span>
          <span>Actor</span>
          <span>Call</span>
          <span>Status</span>
          <span>Detail</span>
        </div>
        <ol>
          {rows.map((row, index) => (
            <li key={index} className={`${TRACE_ROW} border-t border-border first:max-sm:border-t-0`}>
              <span className="tabular-nums text-muted">
                <span className="sm:hidden">Step </span>
                {index + 1}
                <span className="sm:hidden">
                  {" "}
                  · {row.actor} · {row.status}
                </span>
              </span>
              <span className="max-sm:hidden">{row.actor}</span>
              <span className="min-w-0 break-words font-mono">
                <TraceText text={row.call} />
              </span>
              <span className="max-sm:hidden">{row.status}</span>
              <span className="min-w-0 break-words text-muted">{row.detail}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
