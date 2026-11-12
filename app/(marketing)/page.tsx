// Landing page: the failure Integration Proof catches, in plain words, and why to trust the result.
import Link from "next/link";
import { SCENARIO_TITLES } from "../_components/report";
import { Icon } from "../_components/icon";
import { GITHUB_URL } from "../_components/site";
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
  { title: "You see what buyers see", body: "Each scenario ends in plain words: charged twice, shipped twice, or fine." },
  { title: "Claude writes the fix", body: "We run the scenario again on the fixed store, offline on a model of PayPal, to check it works." },
];

/** Proving a team's own store: docs/store-contract.md and the CLI in cli/. */
const OWN_STORE_STEPS = [
  "Add three endpoints from the store contract.",
  "Run the CLI against the PayPal sandbox.",
  "Claude explains each failure and writes a patch you apply.",
];

/**
 * The command from the README's "Prove your own store", the opt-in Claude flags included, exactly
 * as the README writes it. On a phone every flag gets a line of its own, so nothing is cut off.
 */
const OWN_STORE_COMMAND = `npm run cli -- run \\
  --store http://localhost:4000/integration-proof \\
  --env-file .env.cli \\
  --explain --source examples/express-store \\
  --write-patch claude-fix.patch`;
const OWN_STORE_COMMAND_NARROW = `npm run cli -- run \\
  --store \\
  http://localhost:4000/integration-proof \\
  --env-file .env.cli \\
  --explain \\
  --source examples/express-store \\
  --write-patch claude-fix.patch`;

const AUDIENCE = ["Teams with a custom PayPal Checkout", "Plugin and platform authors", "Anyone before a launch or a sale day"];

const h2 = "mt-3 text-[clamp(2rem,3.4vw,2.5rem)] font-semibold leading-[1.08] tracking-display text-balance";

/**
 * A big stat. Proportional figures: Geist's tabular "1" is a different glyph, with a foot serif,
 * that reads as a monospaced face at display sizes.
 */
const stat = "text-[clamp(3rem,5.5vw,4.5rem)] font-semibold leading-none tracking-[-0.045em] proportional-nums";
const section = "flex flex-col py-16 sm:py-24";

/** A stat's tile: a card, its number and label centred, every tile as tall as the tallest. */
const tile = "surface-card flex flex-col items-center justify-start rounded-panel px-6 pb-7 pt-8";

/** The arrow of a button that moves on: it steps forward under the pointer. */
const nudge = "transition-transform duration-150 ease-(--ease-out) group-hover:translate-x-0.5";

/** The real checkout of the hardened store, the secondary way in next to the proof. */
function CheckoutLink() {
  return (
    <Link href="/store/hardened" className="group inline-flex min-h-10 items-center gap-1 rounded-control font-medium text-brand">
      Or pay yourself with a real PayPal Checkout <Icon name="arrow-right" className={`size-4 ${nudge}`} />
    </Link>
  );
}

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
      <section className="glow-accent grid items-center gap-10 pb-14 pt-10 sm:pt-14 lg:min-h-[min(37.5rem,calc(100svh-8.25rem))] lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-14 lg:py-10">
        <div className="flex flex-col items-start">
          <h1 className="text-[clamp(2.75rem,3.7vw,3.5rem)] font-semibold leading-[1.04] tracking-display text-balance">
            One lost response. <span className="text-fail lg:block">The buyer pays twice.</span>
          </h1>
          <p className="rise-in mt-6 max-w-[30em] text-lg leading-relaxed text-pretty text-muted sm:text-xl" style={{ "--i": 0 } as React.CSSProperties}>
            Integration Proof breaks a PayPal checkout on purpose, so you see the bad day before your customers do.
          </p>
          <div className="rise-in mt-9 flex flex-col items-start gap-4" style={{ "--i": 1 } as React.CSSProperties}>
            <ProofButton />
            <CheckoutLink />
          </div>
        </div>
        <div className="rise-in" style={{ "--i": 2 } as React.CSSProperties}>
          <Statements price={Number(PRODUCT.amount.value)} currency={PRODUCT.amount.currency_code} />
        </div>
      </section>

      <section className={`${section} border-t border-hairline`} aria-labelledby="decides">
        <p className="eyebrow">Verdicts</p>
        <h2 id="decides" className={h2}>
          Code decides. Not the AI.
        </h2>
        <ul className="mt-8 grid gap-3 text-center sm:mt-10 sm:grid-cols-3 sm:gap-4">
          <li className={tile}>
            <b className={stat}>{scenarioCount}</b>
            <span className="mt-4 text-balance text-muted">failure scenarios, run in PayPal’s sandbox</span>
          </li>
          {fixes && (
            <li className={tile}>
              <b className={stat}>
                {fixes.verified}/{fixes.total}
              </b>
              <a href={fixes.report} className={`mt-4 rounded-sm text-balance text-muted ${linkProse.replace("text-brand", "")}`}>
                Claude’s fixes verified offline, on a model of PayPal
              </a>
            </li>
          )}
          <li className={tile}>
            <b className={stat}>Code</b>
            <span className="mt-4 text-balance text-muted">decides every verdict. Claude explains it and proposes the fix.</span>
          </li>
        </ul>
      </section>

      <section id="how-it-works" className={`${section} border-t border-hairline`} aria-labelledby="how">
        <p className="eyebrow">The method</p>
        <h2 id="how" className={h2}>
          How it works
        </h2>
        <ol className="steps-across mt-8 grid gap-8 sm:mt-10 md:grid-cols-3 md:gap-12">
          {STEPS.map((step, index) => (
            <li key={step.title} className="step-row flex flex-col">
              <span className="step-number">{index + 1}</span>
              <h3 className="mt-4 text-xl font-semibold tracking-tight">{step.title}</h3>
              <p className="mt-2 leading-relaxed text-pretty text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={`${section} border-t border-hairline`} aria-labelledby="own-store">
        <p className="eyebrow">Store contract</p>
        <h2 id="own-store" className={h2}>
          Prove your own store.
        </h2>
        <p className="mt-4 text-lg text-pretty text-muted sm:text-xl">Three endpoints. One command. Real PayPal sandbox.</p>
        <div className="mt-8 grid gap-10 sm:mt-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-14">
          <ol className="steps-down flex flex-col gap-10">
            {OWN_STORE_STEPS.map((step, index) => (
              <li key={step} className="step-row flex gap-4">
                <span className="step-number">{index + 1}</span>
                <p className="pt-0.5 text-xl font-semibold leading-snug tracking-tight text-pretty">{step}</p>
              </li>
            ))}
          </ol>
          <div className="flex min-w-0 flex-col gap-5">
            {/* Scrolls sideways on a narrow screen; focusable, so the keyboard can scroll it too. */}
            <pre
              tabIndex={0}
              aria-label="The command that proves your store"
              className="overflow-x-auto rounded-panel border border-hairline bg-sunken p-4 font-mono text-xs leading-6 shadow-[inset_0_1px_0_var(--highlight-top)] sm:px-5 sm:py-4.5 sm:text-sm"
            >
              <code className="sm:hidden">{OWN_STORE_COMMAND_NARROW}</code>
              <code className="max-sm:hidden">{OWN_STORE_COMMAND}</code>
            </pre>
            <p className="leading-relaxed text-pretty">
              An Express store we did not write the tool for: S2 and S3 went from{" "}
              <span className="font-semibold text-fail">FAIL</span> to <span className="font-semibold text-pass">PASS</span> after
              Claude&apos;s patch.{" "}
              <a href={`${GITHUB_URL}/blob/main/docs/store-contract-claude-run.md`} className={linkProse}>
                See the run
              </a>
            </p>
            <p className="flex flex-wrap gap-x-5 gap-y-2">
              <a href={`${GITHUB_URL}/blob/main/docs/store-contract.md`} className={linkProse}>
                Store contract
              </a>
              <a href={`${GITHUB_URL}/blob/main/.github/workflows/store-contract.yml`} className={linkProse}>
                CI example
              </a>
            </p>
            <p className="text-sm text-text-3">Runs from a clone today. Webhook scenarios need a public URL.</p>
          </div>
        </div>
      </section>

      <section className={`${section} border-t border-hairline`} aria-labelledby="guidance">
        <p className="eyebrow">PayPal’s documentation</p>
        <h2 id="guidance" className={h2}>
          PayPal documents the right behavior. Integration Proof checks it.
        </h2>
        <ul className="mt-8 grid gap-8 sm:mt-10 md:grid-cols-3 md:gap-12">
          {GUIDANCE.map((item) => (
            <li key={item.quote}>
              <figure className="quote-rule m-0 flex flex-col gap-4 pt-6">
                {/* The opening quote hangs outside the text edge, so the words line up with the caption. */}
                <blockquote cite={item.url} className="m-0 -indent-[0.42em] text-[1.1875rem] leading-[1.6] text-pretty">
                  “{item.quote}”
                </blockquote>
                <figcaption className="text-small text-text-3">
                  <a href={item.url} className={`${linkProse} text-text-3 decoration-text-3/40 hover:text-foreground hover:decoration-current`}>
                    {item.source}
                  </a>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </section>

      <section className="border-t border-hairline py-8" aria-labelledby="who">
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

      <section className="border-t border-hairline py-16 sm:py-24" aria-labelledby="try">
        <div className="surface-featured flex flex-col items-center rounded-[var(--radius-feature)] px-6 py-14 text-center sm:px-10 sm:py-20">
          <p className="eyebrow">Live proof</p>
          <h2 id="try" className={h2}>
            Is your checkout ready for a bad day?
          </h2>
          <div className="mt-9 flex flex-col items-center gap-4">
            <ProofButton />
            <CheckoutLink />
          </div>
        </div>
      </section>
    </div>
  );
}
