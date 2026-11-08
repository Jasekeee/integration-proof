// Landing page: the failure Integration Proof catches, in plain words, and why to trust the result.
import Link from "next/link";
import { SCENARIO_TITLES } from "../_components/report";
import { Icon } from "../_components/icon";
import { buttonPrimary, linkProse } from "../_components/ui";
import { Statements } from "./statements";
import { fixesSummary } from "@/lib/ai/fix-check";
import { PRODUCT } from "@/lib/store/shared";

/**
 * PayPal's own words, quoted verbatim from developer.paypal.com. An ellipsis marks where PayPal's
 * sentence goes on. Re-check the pages before changing a quote; never reword one inside quotes.
 */
const GUIDANCE = [
  {
    quote: "You can retry idempotent calls that fail with network timeouts or HTTP 5xx status codes…",
    source: "PayPal REST API reference · Idempotency",
    url: "https://developer.paypal.com/api/rest/reference/idempotency/",
  },
  {
    quote: "Any non-2xx status code will cause PayPal to reattempt delivery up to 25 times over the course of 3 days…",
    source: "PayPal REST API · Webhooks",
    url: "https://developer.paypal.com/api/rest/webhooks/",
  },
  {
    quote: "If you do not verify a message, you will not have a way to validate that its sender was in fact PayPal.",
    source: "PayPal REST API · Webhooks",
    url: "https://developer.paypal.com/api/rest/webhooks/",
  },
];

const STEPS = [
  { title: "We break it on purpose", body: "Real checkouts in PayPal’s sandbox, broken the way bad days break them." },
  { title: "You see what buyers see", body: "Each test ends in plain words: charged twice, shipped twice, or fine." },
  { title: "Claude writes the fix", body: "We run the test again, offline, on the fixed store to prove it works." },
];

const AUDIENCE = ["Teams with a custom PayPal Checkout", "Plugin and platform authors", "Anyone before a launch or a sale day"];

const h2 = "text-[clamp(2rem,4vw,3.25rem)] font-semibold leading-[1.05] tracking-display text-balance";
const section = "flex flex-col py-20 sm:py-28";

/** The arrow of a button that moves on: it steps forward under the pointer. */
const nudge = "transition-transform duration-150 ease-(--ease-out) group-hover:translate-x-0.5";

function ProofButton() {
  return (
    <Link href="/proof" className={`group ${buttonPrimary} min-h-12 rounded-full px-6 text-base`}>
      See the live proof <Icon name="arrow-right" className={`size-4 ${nudge}`} />
    </Link>
  );
}

export default function LandingPage() {
  const fixes = fixesSummary();
  const scenarioCount = Object.keys(SCENARIO_TITLES).length;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col px-4 sm:px-6">
      <section className="grid items-center gap-12 pb-16 pt-14 sm:pt-20 lg:min-h-[min(42rem,calc(100svh-4.25rem))] lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-14 lg:py-12">
        <div className="flex flex-col items-start">
          <h1 className="text-[clamp(2.75rem,3.7vw,3.5rem)] font-semibold leading-[1.04] tracking-display text-balance">
            One lost response. <span className="text-fail lg:block">The buyer pays twice.</span>
          </h1>
          <p className="mt-6 max-w-[30em] text-lg leading-relaxed text-pretty text-muted sm:text-xl">
            Integration Proof breaks a PayPal checkout on purpose, so you see the bad day before your customers do.
          </p>
          <div className="mt-9">
            <ProofButton />
          </div>
        </div>
        <Statements price={Number(PRODUCT.amount.value)} currency={PRODUCT.amount.currency_code} />
      </section>

      <section id="how-it-works" className={`${section} scroll-mt-4 border-t border-border`} aria-labelledby="how">
        <h2 id="how" className={h2}>
          How it works
        </h2>
        <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-12">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex flex-col">
              <span className="font-semibold tabular-nums text-brand">{index + 1}</span>
              <h3 className="mt-3 text-xl font-semibold tracking-tight">{step.title}</h3>
              <p className="mt-2 leading-relaxed text-pretty text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={`${section} border-t border-border`} aria-labelledby="guidance">
        <h2 id="guidance" className={h2}>
          PayPal documents the right behavior. Integration Proof checks it.
        </h2>
        <ul className="mt-12 grid gap-8 md:grid-cols-3 md:gap-12">
          {GUIDANCE.map((item) => (
            <li key={item.quote}>
              <figure className="m-0 flex flex-col gap-4">
                {/* The opening quote hangs outside the text edge, so the words line up with the caption. */}
                <blockquote cite={item.url} className="m-0 -indent-[0.42em] text-lg leading-relaxed text-pretty">
                  “{item.quote}”
                </blockquote>
                <figcaption className="text-small text-muted">
                  <a href={item.url} className={linkProse}>
                    {item.source}
                  </a>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${section} border-t border-border`} aria-labelledby="decides">
        <h2 id="decides" className={h2}>
          Code decides. Not the AI.
        </h2>
        <ul className="mt-12 grid gap-10 text-center sm:grid-cols-3">
          <li className="flex flex-col items-center">
            <b className="text-[clamp(3.5rem,7vw,6rem)] font-semibold leading-none tracking-[-0.05em] tabular-nums">{scenarioCount}</b>
            <span className="mt-3 text-muted">ways a checkout fails</span>
          </li>
          {fixes && (
            <li className="flex flex-col items-center">
              <b className="text-[clamp(3.5rem,7vw,6rem)] font-semibold leading-none tracking-[-0.05em] tabular-nums">
                {fixes.verified}/{fixes.total}
              </b>
              <a href={fixes.report} className={`mt-3 rounded-sm text-muted ${linkProse.replace("text-brand", "")}`}>
                Claude fixes proven to work
              </a>
            </li>
          )}
          <li className="flex flex-col items-center">
            <b className="text-[clamp(3.5rem,7vw,6rem)] font-semibold leading-none tracking-[-0.05em] tabular-nums">0</b>
            <span className="mt-3 text-muted">results decided by AI</span>
          </li>
        </ul>
      </section>

      <section className="border-t border-border py-10" aria-labelledby="who">
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-2 text-lg">
          <span id="who" className="font-semibold">
            Who it is for:
          </span>
          {AUDIENCE.map((item, index) => (
            <span key={item} className="text-muted">
              {item}
              {index < AUDIENCE.length - 1 && <span aria-hidden="true" className="ml-3">·</span>}
            </span>
          ))}
        </p>
      </section>

      <section className="flex flex-col items-center border-t border-border py-24 text-center sm:py-32" aria-labelledby="try">
        <h2 id="try" className={h2}>
          Is your checkout ready for a bad day?
        </h2>
        <div className="mt-9">
          <ProofButton />
        </div>
        <p className="mt-6 text-sm text-muted">
          Or pay in the sandbox yourself:{" "}
          <Link href="/store/naive" className={linkProse}>
            naive store
          </Link>{" "}
          ·{" "}
          <Link href="/store/hardened" className={linkProse}>
            hardened store
          </Link>
        </p>
      </section>
    </div>
  );
}
