// Landing page: the failure Integration Proof catches, the PayPal guidance behind it, and how it works.
import Link from "next/link";
import { SCENARIO_TITLES } from "../_components/report";
import { Icon } from "../_components/icon";
import { GITHUB_URL } from "../_components/site";
import { buttonPrimary, buttonSecondary, eyebrow, linkProse } from "../_components/ui";
import { S3Race } from "./s3-race";
import { fixesSummary } from "@/lib/ai/fix-check";

/** The demo video. While it is empty, the second button opens the source instead. */
const DEMO_VIDEO_URL = "";

/**
 * PayPal's own words, quoted verbatim from developer.paypal.com. An ellipsis marks where PayPal's
 * sentence goes on. Re-check the pages before changing a quote; never reword one inside quotes.
 */
const GUIDANCE = [
  {
    quote: "You can retry idempotent calls that fail with network timeouts or HTTP 5xx status codes…",
    source: "PayPal REST API reference · Idempotency",
    url: "https://developer.paypal.com/api/rest/reference/idempotency/",
    scenarios: "S2, S3",
    question: (
      <>
        Does your store retry with the same <code className="font-mono text-small">PayPal-Request-Id</code>, and ask
        PayPal before it tells a buyer the payment failed?
      </>
    ),
  },
  {
    quote: "Any non-2xx status code will cause PayPal to reattempt delivery up to 25 times over the course of 3 days…",
    source: "PayPal REST API · Webhooks",
    url: "https://developer.paypal.com/api/rest/webhooks/",
    scenarios: "S4, S5",
    question: "Does your store ship once when the same event arrives twice, and stay refunded when a late event arrives last?",
  },
  {
    quote: "If you do not verify a message, you will not have a way to validate that its sender was in fact PayPal.",
    source: "PayPal REST API · Webhooks",
    url: "https://developer.paypal.com/api/rest/webhooks/",
    scenarios: "S6",
    question: "Does your store reject a delivery whose body was changed after PayPal signed it?",
  },
];

/** What each failure costs the naive store; S1 is handled by both. Matches the proof's headlines. */
const COSTS: { id: string; title: string; outcome: string; pass?: boolean }[] = [
  { id: "S1", title: "The card is declined", outcome: "Both stores: decline shown, nothing charged", pass: true },
  { id: "S2", title: "PayPal fails once", outcome: "Naive: a buyer ready to pay is told it failed" },
  { id: "S3", title: "The answer arrives late", outcome: "Naive: the buyer pays twice for one cart" },
  { id: "S4", title: "The same event, twice", outcome: "Naive: the order ships twice" },
  { id: "S5", title: "Events out of order", outcome: "Naive: a refunded order shows as paid" },
  { id: "S6", title: "A body changed after signing", outcome: "Naive: a forged refund is accepted" },
];

const STEPS = [
  {
    label: "Break",
    title: "Inject a failure",
    body: "A proxy between the store and the PayPal sandbox declines, fails or holds the capture. Real webhooks are replayed and forged.",
  },
  {
    label: "Judge",
    title: "Code decides",
    body: "The verdict compares the store with PayPal's own record of every order for the cart. The model never decides.",
  },
  {
    label: "Explain",
    title: "Claude finds the cause",
    body: "Root cause, what it costs, and evidence that links to the exact trace steps.",
  },
  {
    label: "Verify",
    title: "The fix is tested",
    body: "Claude's patch is applied to the store and the same failure runs again, offline, in CI: FAIL → PASS.",
  },
];

const AUDIENCE = [
  {
    title: "Teams with a custom PayPal Checkout",
    body: "You call Orders v2 and handle webhooks yourself. Your happy-path tests pass, and you have never seen your store answer a lost response.",
  },
  {
    title: "Plugin and platform authors",
    body: "One integration ships to thousands of stores. One missed retry ships with it.",
  },
  {
    title: "Before a launch or a sale day",
    body: "Traffic peaks are when timeouts and retries happen. Find out in the sandbox, not from a refund request.",
  },
];

const section = "flex flex-col gap-8 border-t border-border py-16";
const h2 = "text-h2 font-semibold tracking-tight text-balance";
const sub = "measure leading-relaxed text-muted";

/** The arrow of a button that moves on: it steps forward under the pointer. */
const nudge = "transition-transform duration-150 ease-(--ease-out) group-hover:translate-x-0.5";

export default function LandingPage() {
  const fixes = fixesSummary();
  const scenarioCount = Object.keys(SCENARIO_TITLES).length;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col px-4 sm:px-6">
      <section className="grid items-center gap-10 pb-12 pt-16 lg:grid-cols-[1fr_1.05fr] lg:pb-16 lg:pt-20">
        <div className="flex flex-col">
          <p className={eyebrow}>Failure testing for PayPal Checkout</p>
          <h1 className="mb-5 mt-4 text-display-sm font-semibold tracking-display text-balance sm:text-display">
            One lost response. <span className="text-brand">The buyer pays twice.</span>
          </h1>
          <p className="max-w-[34em] text-lg leading-[1.65] text-pretty text-muted">
            Integration Proof breaks a PayPal Checkout integration on purpose in the PayPal sandbox: a declined card, a 500,
            a lost response, duplicate and forged webhooks. Code decides PASS or FAIL. Claude explains each failure and
            writes a fix that is tested before you see it.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/proof" className={`group ${buttonPrimary}`}>
              See the live proof <Icon name="arrow-right" className={`size-4 ${nudge}`} />
            </Link>
            {DEMO_VIDEO_URL ? (
              <a href={DEMO_VIDEO_URL} className={buttonSecondary}>
                Watch the 2-minute demo
              </a>
            ) : (
              <a href={GITHUB_URL} className={buttonSecondary}>
                View the source
              </a>
            )}
          </div>
          <ul className="mt-6 flex flex-wrap gap-x-4 gap-y-2 text-small tabular-nums text-muted">
            <li>
              <b className="font-semibold text-foreground">{scenarioCount}</b> failure scenarios
            </li>
            <li>
              <b className="font-semibold text-foreground">Real</b> PayPal sandbox and webhooks
            </li>
            {fixes && (
              <li>
                <a href={fixes.report} className="rounded-sm transition-colors duration-150 hover:text-foreground">
                  <b className="font-semibold text-foreground">
                    {fixes.verified}/{fixes.total}
                  </b>{" "}
                  Claude fixes verified
                </a>
              </li>
            )}
          </ul>
        </div>
        <S3Race />
      </section>

      <section className={section} aria-labelledby="guidance">
        <div className="flex flex-col gap-3">
          <h2 id="guidance" className={h2}>
            PayPal documents the right behavior. Integration Proof checks that you built it.
          </h2>
          <p className={sub}>
            Every scenario comes from PayPal&apos;s own guidance. The proof turns each rule into a failure you can watch, in
            the sandbox, with PayPal&apos;s record as the judge.
          </p>
        </div>
        <ul className="grid gap-4 lg:grid-cols-3">
          {GUIDANCE.map((item) => (
            <li key={item.quote} className="flex flex-col rounded-card border border-border bg-surface p-5">
              <figure className="m-0 flex flex-1 flex-col gap-3">
                {/* The opening quote hangs outside the text edge, so the words line up with the caption. */}
                <blockquote cite={item.url} className="m-0 -indent-[0.42em] text-base leading-relaxed text-pretty">
                  “{item.quote}”
                </blockquote>
                <figcaption className="text-xs text-muted">
                  —{" "}
                  <a href={item.url} className={linkProse}>
                    {item.source}
                  </a>
                </figcaption>
              </figure>
              <p className="mt-4 border-t border-dashed border-border pt-4 text-small leading-relaxed">
                <b className="font-semibold text-brand">{item.scenarios}</b> · {item.question}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className={section} aria-labelledby="costs">
        <div className="flex flex-col gap-3">
          <h2 id="costs" className={h2}>
            Six failures, and what each one costs
          </h2>
          <p className={sub}>
            Run against two reference stores side by side. The naive store keeps the common mistakes; the hardened store
            fixes each one.
          </p>
        </div>
        <ul className="grid gap-3 md:grid-cols-3">
          {COSTS.map((item) => (
            <li key={item.id} className="flex flex-col gap-1 rounded-card border border-border p-4">
              <span className="text-xs text-muted">
                <span className="font-mono">{item.id}</span> · {SCENARIO_TITLES[item.id]}
              </span>
              <span className="mt-1 font-semibold">{item.title}</span>
              <span className={`text-small ${item.pass ? "text-pass" : "text-fail"}`}>{item.outcome}</span>
            </li>
          ))}
        </ul>
      </section>

      <section id="how-it-works" className={`${section} scroll-mt-4`} aria-labelledby="how">
        <div className="flex flex-col gap-3">
          <h2 id="how" className={h2}>
            How a proof runs
          </h2>
          <p className={sub}>One to two minutes per store. Every request, response and webhook goes into a trace you can open.</p>
        </div>
        <ol className="grid gap-3 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step.label} className="flex flex-col gap-2 rounded-card border border-border bg-surface p-5">
              <span className="font-mono text-label font-semibold uppercase tracking-label text-brand">
                {String(index + 1).padStart(2, "0")} · {step.label}
              </span>
              <h3 className="text-base font-semibold">{step.title}</h3>
              <p className="text-sm leading-relaxed text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
        {fixes && (
          <p className="measure text-sm leading-relaxed tabular-nums text-muted">
            Claude&apos;s fixes, verified offline: {fixes.verified}/{fixes.total}, on a deterministic model of PayPal built
            from sandbox observations.{" "}
            <a href={fixes.report} className={linkProse}>
              Read the report
            </a>
          </p>
        )}
      </section>

      <section className={section} aria-labelledby="who">
        <h2 id="who" className={h2}>
          Who it is for
        </h2>
        <ul className="grid gap-8 lg:grid-cols-3">
          {AUDIENCE.map((item) => (
            <li key={item.title} className="flex flex-col gap-2">
              <h3 className="text-base font-semibold">{item.title}</h3>
              <p className="leading-relaxed text-pretty text-muted">{item.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${section} items-start`} aria-labelledby="try">
        <div className="flex flex-col gap-3">
          <h2 id="try" className={h2}>
            See it on two stores
          </h2>
          <p className={sub}>
            The proof runs the same six failures against the naive store and the hardened one, side by side. Or pay
            through a real PayPal Checkout yourself in the{" "}
            <Link href="/store/naive" className={linkProse}>
              naive store
            </Link>{" "}
            or the{" "}
            <Link href="/store/hardened" className={linkProse}>
              hardened store
            </Link>
            , and watch PayPal&apos;s webhook arrive.
          </p>
        </div>
        <Link href="/proof" className={`group ${buttonPrimary}`}>
          See the live proof <Icon name="arrow-right" className={`size-4 ${nudge}`} />
        </Link>
      </section>
    </div>
  );
}
