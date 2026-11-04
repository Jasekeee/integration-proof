// Landing page: what Integration Proof is, the failure it catches, and how it works.
import Link from "next/link";
import { GITHUB_URL } from "../_components/site";

const STORY = [
  { title: "PayPal captured the payment.", body: "The buyer's money moved; PayPal has the capture." },
  { title: "The response got lost.", body: "The answer reached the store after the store had stopped waiting." },
  { title: "The store said “Payment failed”.", body: "It treated the timeout as a failed payment, without asking PayPal." },
  { title: "The buyer paid twice.", body: "They checked out the same cart again: a second order and a second charge." },
];

const STEPS = [
  {
    title: "Inject a failure",
    body:
      "A fault-injection proxy sits between the store and the PayPal sandbox. It declines a capture, fails it with a 500, " +
      "or captures and holds the answer. The runner replays and forges real webhook deliveries.",
  },
  {
    title: "Judge it with code",
    body:
      "Every request, response and webhook goes into a trace. Deterministic assertions compare the store's state with " +
      "PayPal's own record of each order and decide PASS or FAIL. The model never decides a verdict.",
  },
  {
    title: "Explain and fix with Claude",
    body:
      "For each failure Claude reads the trace and the store's code, names the root cause and what it costs, and writes a " +
      "patch. The patch is applied to the real file before it is shown.",
  },
];

const SCENARIOS = [
  ["S1", "Declined capture", "The buyer sees a decline and nothing is charged."],
  ["S2", "Transient 5xx on capture", "The store retries instead of losing the sale."],
  ["S3", "Lost response after a successful capture", "The store asks PayPal before telling the buyer it failed."],
  ["S4", "Duplicate webhook", "The same delivery twice ships the order once."],
  ["S5", "Late redelivery of COMPLETED after a refund", "The order stays refunded, as PayPal reports."],
  ["S6", "Forged webhook", "A body changed after signing is rejected and changes nothing."],
];

const BUILT_ON = [
  ["PayPal Orders v2", "Create, confirm payment source, capture and get, against the sandbox."],
  ["Webhooks with signature verification", "verify-webhook-signature on every delivery to the hardened store."],
  ["Sandbox negative testing", "PayPal-Mock-Response declines and 500s, injected by the proxy."],
  ["Idempotency", "One PayPal-Request-Id per capture, so a retry returns the original capture."],
  ["Claude", "Root cause, business impact, evidence from the trace, and a checked patch."],
];

const primary =
  "inline-flex min-h-11 items-center rounded-md bg-accent px-5 text-sm font-semibold text-accent-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const secondary =
  "inline-flex min-h-11 items-center rounded-md border border-border-strong px-5 text-sm font-medium hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring";

export default function LandingPage() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-16 px-4 py-12 sm:px-6 sm:py-20">
      <section className="flex flex-col gap-6">
        <p className="font-mono text-xs uppercase tracking-widest text-muted">PayPal Checkout · sandbox</p>
        <h1 className="max-w-3xl text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Prove your PayPal integration survives a bad day, before your customers find out.
        </h1>
        <p className="max-w-2xl text-lg leading-8 text-muted">
          Integration Proof runs six controlled failures against a PayPal Checkout integration, decides PASS or FAIL for
          each with code, and asks Claude why a failure happened and how to fix it.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link href="/proof" className={primary}>
            Run the proof
          </Link>
          <a href={GITHUB_URL} className={secondary}>
            View the source
          </a>
        </div>
      </section>

      <section className="flex flex-col gap-6" aria-labelledby="story">
        <div className="flex flex-col gap-2">
          <h2 id="story" className="text-2xl font-semibold tracking-tight">
            The failure that charges a buyer twice
          </h2>
          <p className="max-w-2xl text-muted">Scenario S3, on a store with a common integration mistake:</p>
        </div>
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {STORY.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
              <span className="font-mono text-xs text-muted">{index + 1}</span>
              <p className="font-semibold">{step.title}</p>
              <p className="text-sm leading-6 text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
        <p className="max-w-3xl leading-7">
          A hardened store answers the timeout with <code className="font-mono text-sm">GET /v2/checkout/orders/&#123;id&#125;</code>,
          sees the capture, and tells the buyer the payment went through. One charge.
        </p>
      </section>

      <section className="flex flex-col gap-6" aria-labelledby="how">
        <h2 id="how" className="text-2xl font-semibold tracking-tight">
          How it works
        </h2>
        <ol className="grid gap-3 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
              <span className="font-mono text-xs text-muted">Step {index + 1}</span>
              <p className="font-semibold">{step.title}</p>
              <p className="text-sm leading-6 text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="grid gap-10 lg:grid-cols-2" aria-label="Scenarios and technology">
        <div className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold tracking-tight">Six scenarios</h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {SCENARIOS.map(([id, title, pass]) => (
              <li key={id} className="flex gap-3 p-4">
                <span className="font-mono text-xs text-muted">{id}</span>
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-semibold">{title}</p>
                  <p className="text-sm text-muted">{pass}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="flex flex-col gap-4">
          <h2 className="text-2xl font-semibold tracking-tight">Built on</h2>
          <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
            {BUILT_ON.map(([title, body]) => (
              <li key={title} className="flex flex-col gap-1 p-4">
                <p className="text-sm font-semibold">{title}</p>
                <p className="text-sm text-muted">{body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="flex flex-col items-start gap-4 rounded-lg border border-border bg-surface p-6 sm:p-8">
        <h2 className="text-2xl font-semibold tracking-tight">See it on two stores</h2>
        <p className="max-w-2xl text-muted">
          The proof runs the same six failures against a naive store and a hardened one, side by side, in about two minutes.
        </p>
        <Link href="/proof" className={primary}>
          Run the proof
        </Link>
      </section>
    </div>
  );
}
