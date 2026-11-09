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

const POLL_MS = 3000;
/** The proof waits as long for a webhook (WEBHOOK_WAIT_MS); deliveries took 7 to 60 s. */
const WEBHOOK_WAIT_MS = 150_000;
const COMPLETED = "PAYMENT.CAPTURE.COMPLETED";

const CreatedSchema = z.object({ orderId: z.string() });
const CapturedSchema = z.object({ status: z.string(), captureId: z.string().nullable(), message: z.string() });
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
  | { kind: "captured"; status: string; message: string; captureId: string | null }
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

  /** The store creates the order; the SDK opens PayPal with its id. */
  const createOrder = useCallback(async (): Promise<{ orderId: string }> => {
    const cart = newCartId();
    cartRef.current = cart;
    setCartId(cart);
    setState(null);
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
      setCapturing(true);
      try {
        const response = await fetch(`/api/store/${mode}/orders/${encodeURIComponent(orderId)}/capture`, { method: "POST" });
        const body = CapturedSchema.safeParse(await response.clone().json().catch(() => null));
        if (!response.ok || !body.success) {
          setPhase({ kind: "error", message: await readError(response, "The store could not capture the order") });
          return;
        }
        setPhase({ kind: "captured", status: body.data.status, message: body.data.message, captureId: body.data.captureId });
        if (cartRef.current) window.history.replaceState(null, "", `?cart=${cartRef.current}`);
        setPolling({ since: Date.now() });
      } finally {
        setCapturing(false);
      }
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
  const shareUrl = cartId && (phase.kind === "captured" || initialCart) ? `/store/${mode}?cart=${cartId}` : null;
  const components = useMemo(() => ["paypal-payments", "paypal-guest-payments"] as const, []);
  const webhook = state?.deliveries.find((delivery) => delivery.eventType === COMPLETED) ?? null;
  const fulfilled = order && delivered(state) ? order : null;
  // A cart is paid once the store's capture said PAID, or, on a reload with ?cart=, once the store's
  // state shows a capture. A paid cart never shows a payment button again.
  const capturedOrder = state?.orders.find((candidate) => candidate.captureId !== null) ?? null;
  const paid =
    phase.kind === "captured" && phase.status === "PAID"
      ? { captureId: phase.captureId ?? capturedOrder?.captureId ?? null }
      : capturedOrder
        ? { captureId: capturedOrder.captureId }
        : null;
  // A shared transaction link shows that cart only; a new checkout starts from the plain page.
  const showButtons = !initialCart && !paid && !capturing;
  const total = `${product.amount.value} ${product.amount.currency_code}`;

  return (
    // Panels on a surface, like a scenario's scene on /proof: the order with its total and PayPal's
    // buttons on the left, the sandbox's testing details, quieter, on the right, and below them what
    // the store and PayPal did. On a phone the order comes first.
    <div className="flex flex-col gap-3 rounded-panel bg-surface p-3 sm:gap-4 sm:p-4">
      <div className="grid gap-3 sm:gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
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
                {/* Holds the two buttons' height (45 px each and the gap) while the SDK draws them, so the page does not move. */}
                <div className="flex min-h-[102px] flex-col gap-3" aria-busy={phase.kind === "paying"}>
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

          {!showButtons && <Receipt mode={mode} total={total} paid={paid} capturing={capturing} loading={Boolean(initialCart) && !state} />}

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
              . Reviewers get the sandbox buyer login with the testing instructions.
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
            done={Boolean(paid) || phase.kind === "captured" || Boolean(order?.captureId)}
            text={
              phase.kind === "captured"
                ? `${phase.status} · ${phase.message}`
                : order?.captureId
                  ? `${order.status} · capture ${order.captureId}`
                  : capturing
                    ? "Capturing the payment…"
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
 * In place of PayPal's buttons once the cart is paid, or while the store captures: the amount, the
 * capture id and a way to start again. A new checkout loads the plain page, so it opens a new cart.
 */
function Receipt({
  mode,
  total,
  paid,
  capturing,
  loading,
}: {
  mode: Mode;
  total: string;
  paid: { captureId: string | null } | null;
  capturing: boolean;
  /** A shared link whose cart has not been read yet. */
  loading: boolean;
}) {
  const again = (
    <a href={`/store/${mode}`} className={`${buttonSecondary} self-start`}>
      Start a new checkout
    </a>
  );
  if (paid) {
    return (
      <div role="status" className="flex flex-col gap-3 rounded-card bg-pass-bg p-4 sm:p-5">
        <p className="flex items-center gap-2 text-lg font-semibold text-pass">
          {check}
          Paid {total}
        </p>
        {paid.captureId && (
          <p className="text-sm text-muted">
            Capture <span className="break-all font-mono text-foreground">{paid.captureId}</span>
          </p>
        )}
        {again}
      </div>
    );
  }
  return (
    <div role="status" className="flex min-h-[102px] flex-col justify-center gap-3 rounded-card bg-surface p-4 sm:p-5">
      {capturing || loading ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <span aria-hidden="true" className="spinner" />
          {capturing ? "The store is capturing the payment…" : "Loading this order…"}
        </p>
      ) : (
        <>
          <p className="text-sm text-muted">This cart was not paid.</p>
          {again}
        </>
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
function Stage({ label, done, text, detail = null }: { label: string; done: boolean; text: string; detail?: string | null }) {
  return (
    <li className={`flex min-w-0 flex-col gap-2 rounded-card px-4 py-3 ${done ? "bg-pass-bg" : "bg-surface"}`}>
      <p className="flex items-center gap-2 text-small text-muted">
        {done && check}
        {label}
        {done && <span className="sr-only">: done</span>}
      </p>
      <p className={`text-base font-medium leading-snug text-pretty tabular-nums ${done ? "text-pass" : "text-foreground"}`} suppressHydrationWarning>
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
