"use client";

import { useState } from "react";

/**
 * Scenario S3 on both stores, step by step, in the words of a real run's trace: the store's capture
 * times out after 8 s (storeTimeoutMs), the proxy holds PayPal's 201 for 10 s (proxyHoldMs), and the
 * buyer sees the store's own message. Keep these steps in line with the trace if the stores change.
 * The animation is CSS only (globals.css, .race-step); Replay remounts the lanes so it plays again.
 * With reduced motion the final state shows at once.
 */

type Tone = "plain" | "bad" | "good";

interface Step {
  who: string;
  what: React.ReactNode;
  tone?: Tone;
  /** Seconds after the start at which the step appears. */
  at: number;
}

const code = "rounded bg-surface-2 px-1 font-mono text-[11.5px]";

function Held({ at }: { at: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-bg px-2 py-0.5 font-mono text-[11px] text-warn">
      <i className="race-pulse size-2 rounded-full bg-warn" style={{ "--at": `${at}s` } as React.CSSProperties} />
      answer held 10 s
    </span>
  );
}

const NAIVE: Step[] = [
  { who: "buyer", what: "Pays with a card", at: 0.2 },
  { who: "store", what: <code className={code}>POST …/capture</code>, at: 0.9 },
  { who: "PayPal", what: <>Captured · <code className={code}>201 COMPLETED</code></>, at: 1.6 },
  { who: "proxy", what: <Held at={2.2} />, at: 2.2 },
  { who: "store", what: "Stops waiting after 8 s: “Payment failed. Please try again.”", tone: "bad", at: 3.2 },
  { who: "buyer", what: "Checks out the same cart again", at: 4.1 },
  { who: "PayPal", what: <>Second order captured · <code className={code}>201</code></>, at: 4.9 },
];

const HARDENED: Step[] = [
  { who: "buyer", what: "Pays with a card", at: 0.2 },
  { who: "store", what: <code className={code}>POST …/capture</code>, at: 0.9 },
  { who: "PayPal", what: <>Captured · <code className={code}>201 COMPLETED</code></>, at: 1.6 },
  { who: "proxy", what: <Held at={2.2} />, at: 2.2 },
  { who: "store", what: <>No answer after 8 s, asks PayPal: <code className={code}>GET /v2/checkout/orders/&#123;id&#125;</code></>, at: 3.2 },
  { who: "PayPal", what: <><code className={code}>COMPLETED</code>, capture found</>, at: 4.1 },
  { who: "store", what: "“Payment received. Thank you for your order.”", tone: "good", at: 4.9 },
];

const TONES: Record<Tone, string> = { plain: "", bad: "font-semibold text-fail", good: "font-semibold text-pass" };

function Lane({
  name,
  steps,
  verdict,
  charges,
}: {
  name: string;
  steps: Step[];
  verdict: "PASS" | "FAIL";
  charges: number;
}) {
  const pass = verdict === "PASS";
  return (
    <div className="flex min-h-[340px] flex-col gap-2 rounded-[10px] border border-border bg-background p-3.5">
      <p className="mb-1 flex items-center justify-between text-sm font-semibold">
        {name}
        <span
          className={`race-step rounded-[5px] px-[7px] py-[3px] font-mono text-[11px] font-semibold ${pass ? "bg-pass-bg text-pass" : "bg-fail-bg text-fail"}`}
          style={{ "--at": "6.4s" } as React.CSSProperties}
        >
          {verdict}
        </span>
      </p>
      <ol className="flex flex-col gap-2">
        {steps.map((step, index) => (
          <li
            key={index}
            className="race-step flex items-start gap-2.5 text-[13px] leading-[1.45]"
            style={{ "--at": `${step.at}s` } as React.CSSProperties}
          >
            <span className="w-[52px] shrink-0 pt-0.5 font-mono text-[11px] text-muted">{step.who}</span>
            <span className={`min-w-0 flex-1 ${TONES[step.tone ?? "plain"]}`}>{step.what}</span>
          </li>
        ))}
      </ol>
      <p
        className={`race-step mt-auto flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-semibold ${pass ? "bg-pass-bg text-pass" : "bg-fail-bg text-fail"}`}
        style={{ "--at": "5.8s" } as React.CSSProperties}
      >
        <span>Charges for one cart</span>
        <span className="font-mono text-[22px]">{charges}</span>
      </p>
    </div>
  );
}

export function S3Race() {
  const [round, setRound] = useState(0);
  return (
    <figure
      aria-label="Scenario S3 on the naive and the hardened store"
      className="m-0 rounded-[14px] border border-border bg-surface p-4 shadow-[0_12px_40px_-18px_rgba(0,0,0,0.18)] sm:p-[18px]"
    >
      <figcaption className="mb-3.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] text-muted">Scenario S3 · PayPal captures, the answer arrives late</span>
        <span className="font-mono text-xs text-muted">replayed from a real run, sped up</span>
      </figcaption>
      <div key={round} className="grid gap-3 sm:grid-cols-2">
        <Lane name="Naive store" steps={NAIVE} verdict="FAIL" charges={2} />
        <Lane name="Hardened store" steps={HARDENED} verdict="PASS" charges={1} />
      </div>
      <div className="mt-3 flex items-center justify-between gap-3 text-xs leading-5 text-muted">
        <span>PayPal allows one capture per order: the second charge is a second order.</span>
        <button
          type="button"
          onClick={() => setRound((value) => value + 1)}
          className="min-h-9 shrink-0 rounded-md border border-border-strong bg-background px-3 text-xs font-medium text-foreground hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-ring motion-reduce:hidden"
        >
          Replay
        </button>
      </div>
    </figure>
  );
}
