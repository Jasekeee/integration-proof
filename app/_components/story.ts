// A scenario told in plain words: three or four short frames and a one-line outcome, each chosen by
// a fact read from the run's own trace. When a fact the words need is missing, there is no story
// and the page shows the verdict's headline instead; nothing here is filled in.
import { z } from "zod";
import type { Mode, ScenarioView, StepView } from "./report";

export interface Frame {
  /** The sentence; with a quote, it introduces the store's own words. */
  text: string;
  quote?: string;
  /** The outcome frame: red when it cost something, green when it did not. */
  tone?: "fail" | "pass";
  /** The trace step the sentence comes from; the outcome frame comes from the whole scenario. */
  step?: number;
}

export interface Story {
  frames: Frame[];
  /** The same scenario in one line: what the store did, and what came of it. */
  short: { did: string; got: string; tone: "fail" | "pass" };
}

const Money = z.object({ value: z.string(), currency_code: z.string() });
const Capture = z.object({ id: z.string(), status: z.string(), amount: Money.optional() });
const Order = z.object({
  id: z.string(),
  intent: z.string(),
  status: z.string(),
  purchase_units: z.array(z.object({ payments: z.object({ captures: z.array(Capture).optional() }).optional() })).optional(),
});
const Answer = z.object({ status: z.string(), message: z.string() });
const StoreState = z.object({
  orders: z.array(z.object({ status: z.string(), fulfilments: z.number(), paypalOrderId: z.string().nullable().optional() })),
});
const Delivery = z.object({ outcome: z.string().optional(), verification: z.string().optional() });
const Refund = z.object({ status: z.string() });

type CaptureFact = z.infer<typeof Capture>;

const CAPTURE = /\/v2\/checkout\/orders\/[^/]+\/capture$/;
const ORDER = /^\/v2\/checkout\/orders\/[^/]+$/;
/** The buyer's request to the store: POST /api/store/{mode}/orders/{id}/capture. */
const BUYER_CAPTURE = /^\/api\/store\/[^/]+\/orders\/[^/]+\/capture$/;
const pathOf = (step: StepView) => (step.path ?? "").split("?")[0];

/** "$10" for whole dollars, "$10.50" otherwise; other currencies keep their code. */
export function money(amount: number, currency = "USD"): string {
  const value = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
  return currency === "USD" ? `$${value}` : `${value} ${currency}`;
}

/** The facts a story can use, each read from the trace and parsed; absent when the trace lacks it. */
function facts(steps: StepView[]) {
  // PayPal's own record of the captures, as the runner read it back at the end.
  const paypal = new Map<string, CaptureFact>();
  for (const step of steps) {
    if (step.actor !== "runner" || step.method !== "GET" || !ORDER.test(pathOf(step))) continue;
    const order = Order.safeParse(step.responseBody);
    for (const capture of order.success ? (order.data.purchase_units?.[0]?.payments?.captures ?? []) : []) {
      paypal.set(capture.id, capture);
    }
  }
  const captures = [...paypal.values()];
  const charged = captures.filter((capture) => capture.status === "COMPLETED");
  const storeCaptures = steps.filter((step) => step.actor === "store" && step.method === "POST" && CAPTURE.test(pathOf(step)));
  const answers = steps.flatMap((step) => {
    if (step.actor !== "buyer" || !BUYER_CAPTURE.test(pathOf(step))) return [];
    const answer = Answer.safeParse(step.responseBody);
    return answer.success ? [{ seq: step.seq, ...answer.data }] : [];
  });
  const states = steps.flatMap((step) => {
    if (step.actor !== "runner" || !pathOf(step).endsWith("/state")) return [];
    const state = StoreState.safeParse(step.responseBody);
    return state.success ? [{ seq: step.seq, ...state.data }] : [];
  });
  const delivery = (step: StepView | undefined) => {
    if (!step) return null;
    const parsed = Delivery.safeParse(step.responseBody);
    return { seq: step.seq, status: step.httpStatus, ...(parsed.success ? parsed.data : {}) };
  };
  const refundStep = steps.find((step) => step.actor === "runner" && pathOf(step).endsWith("/refund"));
  const refund = refundStep ? Refund.safeParse(refundStep.responseBody) : null;
  const amount = captures[0]?.amount;
  return {
    captures,
    charged,
    sum: charged.reduce((total, capture) => total + Number(capture.amount?.value ?? Number.NaN), 0),
    price: amount ? Number(amount.value) : null,
    currency: amount?.currency_code ?? "USD",
    storeCaptures,
    held: storeCaptures.find((step) => /held/i.test(step.fault ?? "") && step.httpStatus !== null && step.httpStatus < 300),
    answer: answers[0] ?? null,
    asked: steps.find((step) => step.actor === "store" && step.method === "GET" && ORDER.test(pathOf(step))),
    refund: refundStep && refund?.success ? { seq: refundStep.seq, status: refund.data.status } : null,
    replay: delivery(steps.find((step) => /Replayed/i.test(step.fault ?? ""))),
    forged: delivery(steps.find((step) => /Forged/i.test(`${step.fault ?? ""} ${step.note ?? ""}`))),
    before: states.length > 1 ? states[states.length - 2].orders[0] : null,
    order: states.length > 0 ? states[states.length - 1].orders[0] ?? null : null,
  };
}

type Facts = ReturnType<typeof facts>;

const said = (answer: { seq: number; message: string }): Frame => ({ text: "The store said:", quote: answer.message, step: answer.seq });

/** Each scenario, both ways it can end. A branch only runs when every fact its words name is there. */
const TELLERS: Record<string, (f: Facts) => Story | null> = {
  S1(f) {
    const decline = f.storeCaptures[0];
    if (!decline || decline.httpStatus !== 422 || !f.answer || f.charged.length > 0) return null;
    return {
      frames: [
        { text: "The buyer pressed Pay.", step: f.answer.seq },
        { text: "PayPal declined the card.", step: decline.seq },
        said(f.answer),
        { text: "Nothing was charged.", tone: "pass" },
      ],
      short: { did: "Showed the decline", got: "nothing charged", tone: "pass" },
    };
  },
  S2(f) {
    const first = f.storeCaptures[0];
    if (!first || first.httpStatus === null || first.httpStatus < 500 || !f.answer || !f.order) return null;
    if (f.storeCaptures.length === 1 && f.order.status === "FAILED" && f.charged.length === 0) {
      return {
        frames: [
          { text: "PayPal had a brief error.", step: first.seq },
          { text: "The store gave up after one try.", step: first.seq },
          said(f.answer),
          { text: "Sale lost. The buyer was ready to pay.", tone: "fail" },
        ],
        short: { did: "Gave up after one try", got: "sale lost", tone: "fail" },
      };
    }
    if (f.storeCaptures.length > 1 && f.charged.length === 1 && f.order.status === "PAID") {
      return {
        frames: [
          { text: "PayPal had a brief error.", step: first.seq },
          { text: "The store tried again.", step: f.storeCaptures[1].seq },
          said(f.answer),
          { text: `Paid once: ${money(f.sum, f.currency)}.`, tone: "pass" },
        ],
        short: { did: "Tried again", got: `${money(f.sum, f.currency)} paid`, tone: "pass" },
      };
    }
    return null;
  },
  S3(f) {
    if (!f.held || !f.answer || f.price === null) return null;
    const start = [
      { text: "PayPal took the money.", step: f.held.seq },
      { text: "The answer got lost.", step: f.held.seq },
    ];
    if (f.answer.status === "FAILED" && f.charged.length === 2) {
      return {
        frames: [...start, said(f.answer), { text: `The buyer paid again: ${money(f.sum, f.currency)} instead of ${money(f.price, f.currency)}.`, tone: "fail" }],
        short: { did: "Guessed “failed”", got: `${money(f.sum, f.currency)} instead of ${money(f.price, f.currency)}`, tone: "fail" },
      };
    }
    if (f.asked && f.charged.length === 1 && f.answer.status === "PAID") {
      return {
        frames: [...start, { text: "The store asked PayPal what happened.", step: f.asked.seq }, { text: `Paid once: ${money(f.sum, f.currency)}.`, tone: "pass" }],
        short: { did: "Asked PayPal", got: `${money(f.sum, f.currency)}, charged once`, tone: "pass" },
      };
    }
    return null;
  },
  S4(f) {
    if (!f.replay || !f.order || f.price === null) return null;
    const start = [
      { text: `The buyer paid ${money(f.price, f.currency)}.`, step: f.storeCaptures[0]?.seq },
      { text: "PayPal sent the “paid” notice." },
    ];
    if (f.replay.outcome === "applied" && f.order.fulfilments >= 2) {
      return {
        frames: [...start, { text: "The same notice came again. The store took it as new.", step: f.replay.seq }, { text: "The order shipped twice.", tone: "fail" }],
        short: { did: "Took the repeat as new", got: "shipped twice", tone: "fail" },
      };
    }
    if (f.replay.outcome === "duplicate" && f.order.fulfilments === 1) {
      return {
        frames: [...start, { text: "The same notice came again. The store knew it.", step: f.replay.seq }, { text: "The order shipped once.", tone: "pass" }],
        short: { did: "Recognised the repeat", got: "shipped once", tone: "pass" },
      };
    }
    return null;
  },
  S5(f) {
    if (!f.refund || f.refund.status !== "COMPLETED" || !f.replay || !f.order || f.price === null) return null;
    if (f.captures[0]?.status !== "REFUNDED") return null;
    const start = [
      { text: `The buyer paid ${money(f.price, f.currency)}.`, step: f.storeCaptures[0]?.seq },
      { text: "The merchant refunded it.", step: f.refund.seq },
      { text: "An old “paid” notice arrived after the refund.", step: f.replay.seq },
    ];
    if (f.order.status === "PAID") {
      return {
        frames: [...start, { text: "The store says Paid. PayPal says Refunded.", tone: "fail" }],
        short: { did: "Took the old notice", got: "shows Paid, PayPal says Refunded", tone: "fail" },
      };
    }
    if (f.order.status === "REFUNDED") {
      return {
        frames: [...start, { text: "The store and PayPal both say Refunded.", tone: "pass" }],
        short: {
          did: f.replay.outcome === "duplicate" ? "Ignored the old notice" : "Kept PayPal’s status",
          got: "Refunded, as PayPal says",
          tone: "pass",
        },
      };
    }
    return null;
  },
  S6(f) {
    if (!f.forged || !f.before || !f.order || f.price === null || f.captures[0]?.status !== "COMPLETED") return null;
    const start = [
      { text: `The buyer paid ${money(f.price, f.currency)}.`, step: f.storeCaptures[0]?.seq },
      { text: "Someone sent a fake “refunded” notice.", step: f.forged.seq },
    ];
    if (f.forged.outcome === "applied" && f.before.status === "PAID" && f.order.status === "REFUNDED") {
      return {
        frames: [...start, { text: "The store believed it.", step: f.forged.seq }, { text: "A paid order now shows Refunded.", tone: "fail" }],
        short: { did: "Believed the fake", got: "paid order shows Refunded", tone: "fail" },
      };
    }
    if (f.forged.status !== null && f.forged.status >= 400 && f.forged.status < 500 && f.order.status === f.before.status) {
      return {
        frames: [...start, { text: "The store checked PayPal’s signature and refused it.", step: f.forged.seq }, { text: "The order stays Paid.", tone: "pass" }],
        short: { did: "Checked PayPal’s signature", got: "rejected", tone: "pass" },
      };
    }
    return null;
  },
};

/** The scenario's story, or null when it has no verdict yet or its trace lacks a fact the words need. */
export function story(scenario: ScenarioView | null): Story | null {
  if (!scenario || (scenario.verdict !== "PASS" && scenario.verdict !== "FAIL")) return null;
  const told = TELLERS[scenario.id]?.(facts(scenario.steps ?? [])) ?? null;
  // A story must end the way the verdict did.
  if (!told || told.short.tone !== (scenario.verdict === "PASS" ? "pass" : "fail")) return null;
  return told;
}

/**
 * The scenario names on the proof page, in plain words. The runner and the analyst keep the
 * technical titles (SCENARIO_TITLES), which the technical layer shows.
 */
export const PLAIN_TITLES: Record<string, string> = {
  S1: "The card is declined",
  S2: "PayPal fails for a moment",
  S3: "PayPal’s answer gets lost",
  S4: "A notice arrives twice",
  S5: "A notice arrives late",
  S6: "Someone fakes a notice",
};

/**
 * Why the naive store failed, in plain words: a reading of the root cause Claude gives for each
 * failure, whose own text names functions and sits in the technical layer.
 */
export const PLAIN_CAUSES: Record<string, string> = {
  S2: "The store took a temporary error as final and never tried again.",
  S3: "The store never asked PayPal what happened. It guessed “failed”.",
  S4: "The store never checked whether it had seen this notice before.",
  S5: "The store applied notices in the order they arrived, so an old “paid” overwrote the refund.",
  S6: "The store never checked PayPal’s signature on the notice.",
};

/** The store whose story the scene tells in frames: the one that failed, or the naive one. */
export function storyMode(scenarios: Record<Mode, ScenarioView | null>): Mode {
  return scenarios.naive?.verdict === "PASS" && scenarios.hardened?.verdict === "FAIL" ? "hardened" : "naive";
}
