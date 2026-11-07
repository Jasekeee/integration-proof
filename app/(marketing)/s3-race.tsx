"use client";

import { useEffect, useState } from "react";
import { Odometer } from "../_components/motion";
import { buttonSmall } from "../_components/ui";

/**
 * Scenario S3 on both stores, step by step, in the words of a real run's trace: the store's capture
 * times out after 8 s (storeTimeoutMs), the proxy holds PayPal's 201 for 10 s (proxyHoldMs), and the
 * buyer sees the store's own message. Keep these steps in line with the trace if the stores change.
 * Both lanes show from the first paint with every step in muted gray, which still reads at AA
 * contrast; each step lights up in its own colors at its time (at), the same moment in both lanes.
 * Where the stores part ways (the store's answer at 3.2 s) both rows mark it at once; then the
 * verdicts, and last the charges, which count up. Replay plays it again. With reduced motion the final state shows at once;
 * without JavaScript the gray steps stay readable.
 */

type Tone = "plain" | "bad" | "good";

interface Step {
  who: string;
  what: React.ReactNode;
  tone?: Tone;
  /** The step where the two stores part ways: marked once, in both lanes at the same moment. */
  split?: "bad" | "good";
  /** Seconds after the start at which the step appears. */
  at: number;
}

const code = "rounded bg-surface-2 px-1 font-mono text-label";

/** When the outcome appears, in seconds: the verdicts, then the charges, the story's last word. */
const VERDICT_AT = 5.8;
const CHARGES_AT = 6.4;

/** The row where the stores part ways, marked once in its lane's color as it lights up. */
const SPLIT = { bad: "race-diverge race-diverge-bad", good: "race-diverge race-diverge-good" } as const;

/** A step not yet reached: every color inside it steps back to muted. */
const GHOST = "[&_*]:!text-muted [&_code]:!bg-surface-2 [&_.rounded-full]:!bg-surface-2 [&_i]:!bg-muted";
/** Colors inside a step change together when it lights up. */
const FADE = "[&_*]:transition-colors [&_*]:duration-300 [&_*]:ease-(--ease-out)";

function Held() {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-warn-bg px-2 py-0.5 font-mono text-label text-warn">
      <i className="race-pulse size-2 rounded-full bg-warn" />
      answer held 10 s
    </span>
  );
}

const NAIVE: Step[] = [
  { who: "buyer", what: "Pays with a card", at: 0.2 },
  { who: "store", what: <code className={code}>POST …/capture</code>, at: 0.9 },
  { who: "PayPal", what: <>Captured · <code className={code}>201 COMPLETED</code></>, at: 1.6 },
  { who: "proxy", what: <Held />, at: 2.2 },
  { who: "store", what: "Stops waiting after 8 s: “Payment failed. Please try again.”", tone: "bad", split: "bad", at: 3.2 },
  { who: "buyer", what: "Checks out the same cart again", at: 4.1 },
  { who: "PayPal", what: <>Second order captured · <code className={code}>201</code></>, at: 4.9 },
];

const HARDENED: Step[] = [
  { who: "buyer", what: "Pays with a card", at: 0.2 },
  { who: "store", what: <code className={code}>POST …/capture</code>, at: 0.9 },
  { who: "PayPal", what: <>Captured · <code className={code}>201 COMPLETED</code></>, at: 1.6 },
  { who: "proxy", what: <Held />, at: 2.2 },
  { who: "store", what: <>No answer after 8 s, asks PayPal: <code className={code}>GET /v2/checkout/orders/&#123;id&#125;</code></>, split: "good", at: 3.2 },
  { who: "PayPal", what: <><code className={code}>COMPLETED</code>, capture found</>, at: 4.1 },
  { who: "store", what: "“Payment received. Thank you for your order.”", tone: "good", at: 4.9 },
];

const TONES: Record<Tone, string> = { plain: "", bad: "font-semibold text-fail", good: "font-semibold text-pass" };

/** The outcome: hidden until its time, then it rises into place. */
function outcome(shown: boolean): string {
  return `transition-[opacity,transform] duration-300 ease-(--ease-out) ${shown ? "opacity-100" : "translate-y-1 opacity-0"}`;
}

function Lane({
  name,
  steps,
  verdict,
  charges,
  time,
}: {
  name: string;
  steps: Step[];
  verdict: "PASS" | "FAIL";
  charges: number;
  /** Seconds into the story: what has happened so far. */
  time: number;
}) {
  const pass = verdict === "PASS";
  return (
    <div className="flex min-h-[340px] flex-col gap-2 rounded-card border border-border bg-background p-4">
      <p className="mb-1 flex min-h-6 items-center justify-between text-sm font-semibold">
        {name}
        <span
          className={`inline-flex h-6 items-center rounded-control px-2 font-mono text-label font-semibold ${pass ? "bg-pass-bg text-pass" : "bg-fail-bg text-fail"} ${outcome(time >= VERDICT_AT)}`}
        >
          {verdict}
        </span>
      </p>
      <ol className="isolate flex flex-col gap-2">
        {steps.map((step, index) => (
          <li
            key={index}
            data-lit={time >= step.at ? "" : undefined}
            className={`flex items-start gap-3 text-small ${FADE} ${time >= step.at ? (step.split ? SPLIT[step.split] : "") : GHOST}`}
          >
            <span className="w-12 shrink-0 pt-0.5 font-mono text-label text-muted">{step.who}</span>
            <span className={`min-w-0 flex-1 ${TONES[step.tone ?? "plain"]}`}>{step.what}</span>
          </li>
        ))}
      </ol>
      <p
        className={`mt-auto flex items-center justify-between rounded-control px-3 py-2 text-sm font-semibold ${pass ? "bg-pass-bg text-pass" : "bg-fail-bg text-fail"} ${outcome(time >= CHARGES_AT)}`}
      >
        <span>Charges for one cart</span>
        <span className="font-mono text-2xl tabular-nums">
          {/* Counted up as it appears; still when the story starts at its end (reduced motion). */}
          {time >= CHARGES_AT ? <Odometer value={charges} max={2} roll={Number.isFinite(time)} /> : charges}
        </span>
      </p>
    </div>
  );
}

/** Every moment something changes, in order. */
const MOMENTS = [...new Set([...NAIVE, ...HARDENED].map((step) => step.at).concat(CHARGES_AT, VERDICT_AT))].sort((a, b) => a - b);

export function S3Race() {
  const [round, setRound] = useState(0);
  // The server renders the start; the browser plays the story, or jumps to its end without motion.
  const [time, setTime] = useState(0);
  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const plan: [number, number][] = still ? [[0, Infinity]] : [[0, 0], ...MOMENTS.map((at): [number, number] => [at * 1000, at])];
    const timers = plan.map(([delay, at]) => setTimeout(() => setTime(at), delay));
    return () => timers.forEach(clearTimeout);
  }, [round]);

  return (
    <figure
      aria-label="Scenario S3 on the naive and the hardened store"
      className="m-0 rounded-panel border border-border bg-surface p-4 shadow-raised sm:p-5"
    >
      <figcaption className="mb-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-small text-muted">Scenario S3 · PayPal captures, the answer arrives late</span>
        <span className="font-mono text-xs text-muted">replayed from a real run, sped up</span>
      </figcaption>
      <div className="grid gap-3 sm:grid-cols-2">
        <Lane name="Naive store" steps={NAIVE} verdict="FAIL" charges={2} time={time} />
        <Lane name="Hardened store" steps={HARDENED} verdict="PASS" charges={1} time={time} />
      </div>
      <div className="mt-4 flex items-center justify-between gap-3 text-xs leading-5 text-muted">
        <span>PayPal allows one capture per order: the second charge is a second order.</span>
        <button
          type="button"
          onClick={() => setRound((value) => value + 1)}
          className={`${buttonSmall} min-h-9 text-xs motion-reduce:hidden`}
        >
          Replay
        </button>
      </div>
    </figure>
  );
}
