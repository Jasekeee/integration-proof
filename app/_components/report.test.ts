import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  cellState,
  FALLBACK_HEADLINES,
  MODE_LABELS,
  plainHeadline,
  progressLabel,
  repeatedRequestIds,
  retriedWithSameKey,
  runDate,
  SCENARIO_TITLES,
  shortRequestId,
  traceRow,
  traceSegments,
  verifiedFixes,
  type RunReport,
  type ScenarioView,
  type StepView,
} from "./report";

function scenario(id: string, overrides: Partial<ScenarioView> = {}): ScenarioView {
  return {
    id,
    title: id,
    passWhen: null,
    status: "COMPLETED",
    statusLabel: "completed",
    waitingSince: null,
    verdict: "PASS",
    reason: null,
    headline: null,
    harm: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    analysis: null,
    ...overrides,
  };
}

function report(overrides: Partial<RunReport> = {}): RunReport {
  return {
    id: "run",
    mode: "naive",
    status: "COMPLETED",
    error: null,
    summary: { total: 6, passed: 6, failed: 0, inconclusive: 0, errors: 0 },
    consequences: [],
    config: { storeTimeoutMs: 5000, proxyHoldMs: 10_000, webhookDeadlineMs: 150_000 },
    createdAt: "2026-11-07T09:00:00.000Z",
    startedAt: "2026-11-07T09:00:00.000Z",
    finishedAt: null,
    durationMs: null,
    scenarios: [],
    ...overrides,
  };
}

function step(seq: number, overrides: Partial<StepView> = {}): StepView {
  return {
    id: String(seq),
    seq,
    actor: "store",
    startedAt: "2026-11-07T09:00:00.000Z",
    durationMs: 100,
    method: "POST",
    path: "/v2/checkout/orders/ORDER1/capture",
    httpStatus: 201,
    debugId: "abc123",
    paypalRequestId: null,
    fault: null,
    note: null,
    ...overrides,
  };
}

const fixCheck = (verified: boolean) => ({ verified, before: "FAIL", after: verified ? "PASS" : "FAIL", reason: null, report: "r" });
const analysis = (verified: boolean) =>
  ({ status: "READY", fixCheck: fixCheck(verified) }) as unknown as NonNullable<ScenarioView["analysis"]>;

describe("progressLabel", () => {
  it("counts scenarios with a result, never a partial score", () => {
    const live = report({
      status: "RUNNING",
      scenarios: [
        scenario("S1"),
        scenario("S2", { status: "ERROR", verdict: null }),
        scenario("S3", { status: "COMPLETED", verdict: "FAIL" }),
        scenario("S4", { status: "WAITING_FOR_WEBHOOK", verdict: null }),
        scenario("S5", { status: "RUNNING", verdict: null }),
        scenario("S6", { status: "QUEUED", verdict: null }),
      ],
    });
    expect(progressLabel(live, Date.parse("2026-11-07T09:00:24.500Z"))).toBe("Running · 3 of 6 done · 24 s");
  });

  it("counts from creation while the run is queued", () => {
    const queued = report({ status: "QUEUED", startedAt: null, scenarios: [] });
    expect(progressLabel(queued, Date.parse("2026-11-07T09:00:02.000Z"))).toBe("Running · 0 of 6 done · 2 s");
  });
});

describe("cellState", () => {
  it("shows the verdict once there is one, the live status before", () => {
    expect(cellState(null)).toBe("NOT RUN");
    expect(cellState(scenario("S1", { status: "QUEUED", verdict: null }))).toBe("QUEUED");
    expect(cellState(scenario("S1", { status: "RUNNING", verdict: null }))).toBe("RUNNING");
    expect(cellState(scenario("S1", { status: "WAITING_FOR_WEBHOOK", verdict: null }))).toBe("WAITING");
    expect(cellState(scenario("S1", { verdict: "INCONCLUSIVE" }))).toBe("INCONCLUSIVE");
    expect(cellState(scenario("S1", { status: "ERROR", verdict: null }))).toBe("ERROR");
  });
});

describe("runDate", () => {
  it("names the time on the day itself and the date before", () => {
    const now = new Date(2026, 10, 7, 18, 0).getTime();
    expect(runDate(new Date(2026, 10, 7, 9, 34).toISOString(), now)).toBe("today 09:34");
    expect(runDate(new Date(2026, 10, 5, 11, 32).toISOString(), now)).toBe("Nov 5");
  });
});

describe("verifiedFixes", () => {
  it("counts verified fixes among the failures", () => {
    const done = report({
      scenarios: [
        scenario("S1"),
        scenario("S2", { verdict: "FAIL", analysis: analysis(true) }),
        scenario("S3", { verdict: "FAIL", analysis: analysis(false) }),
        scenario("S4", { verdict: "FAIL", analysis: null }),
      ],
    });
    expect(verifiedFixes(done)).toEqual({ verified: 1, total: 3 });
  });

  it("has nothing to count without failures or while the run is live", () => {
    expect(verifiedFixes(report({ scenarios: [scenario("S1")] }))).toBeNull();
    expect(verifiedFixes(report({ status: "RUNNING", scenarios: [scenario("S2", { verdict: "FAIL" })] }))).toBeNull();
    expect(verifiedFixes(null)).toBeNull();
  });
});

describe("repeatedRequestIds", () => {
  it("gives a color slot only to keys that repeat, in order of first use", () => {
    const colors = repeatedRequestIds([
      { paypalRequestId: "create-key" },
      { paypalRequestId: "capture-key" },
      { paypalRequestId: null },
      { paypalRequestId: "capture-key" },
      { paypalRequestId: "refund-key" },
      { paypalRequestId: "refund-key" },
    ]);
    expect([...colors]).toEqual([
      ["capture-key", 0],
      ["refund-key", 1],
    ]);
  });

  it("shortens a key for its cell", () => {
    expect(shortRequestId("5b37ee3c-c173-419d-9c9c-43f4a531b882")).toBe("5b37ee3c…");
    expect(shortRequestId("short")).toBe("short");
  });
});

describe("retriedWithSameKey", () => {
  const key = "5b37ee3c-c173-419d-9c9c-43f4a531b882";

  it("is true for a failed capture retried with the same key", () => {
    const steps = [
      step(2, { path: "/v2/checkout/orders", paypalRequestId: "create" }),
      step(5, { httpStatus: 500, paypalRequestId: key, fault: "PayPal-Mock-Response INTERNAL_SERVER_ERROR" }),
      step(6, { httpStatus: 201, paypalRequestId: key }),
    ];
    expect(retriedWithSameKey(steps)).toBe(true);
  });

  it("is false without a key, with different keys, or without a successful retry", () => {
    expect(retriedWithSameKey([step(5, { httpStatus: 500 }), step(6, { httpStatus: 201 })])).toBe(false);
    expect(
      retriedWithSameKey([step(5, { httpStatus: 500, paypalRequestId: "a" }), step(6, { httpStatus: 201, paypalRequestId: "b" })]),
    ).toBe(false);
    expect(
      retriedWithSameKey([step(5, { httpStatus: 500, paypalRequestId: key }), step(6, { httpStatus: 500, paypalRequestId: key })]),
    ).toBe(false);
  });

  it("ignores the runner's own calls", () => {
    const steps = [
      step(5, { actor: "runner", httpStatus: 500, paypalRequestId: key }),
      step(6, { actor: "runner", httpStatus: 201, paypalRequestId: key }),
    ];
    expect(retriedWithSameKey(steps)).toBe(false);
  });
});

describe("traceRow", () => {
  it("carries the step's PayPal-Request-Id", () => {
    expect(traceRow(step(6, { paypalRequestId: "k" })).paypalRequestId).toBe("k");
    expect(traceRow(step(6)).paypalRequestId).toBeNull();
  });

  it("lists PayPal's deliveries one per line, with no separator", () => {
    // The runner's note, as lib/proof/runner.ts writes it for two expected deliveries.
    const note =
      "Waited 15.2 s for PayPal webhooks. PAYMENT.CAPTURE.COMPLETED for order 93U333919E574954D acknowledged: verification NOT_CHECKED, outcome applied. PAYMENT.CAPTURE.COMPLETED for order 93U333919E574954D acknowledged: verification NOT_CHECKED, outcome applied.";
    const row = traceRow(step(7, { actor: "runner", method: null, path: null, note }));
    expect(row.actor).toBe("PayPal");
    expect(row.call).toBe("Webhook delivered:\nPAYMENT.CAPTURE.COMPLETED\nPAYMENT.CAPTURE.COMPLETED");
    expect(row.call).not.toContain(",");
  });

  it("lists missing deliveries one per line too", () => {
    const row = traceRow(step(7, { actor: "runner", method: null, path: null, note: "Waited 150.0 s for PayPal webhooks. No acknowledged PAYMENT.CAPTURE.REFUNDED for order 93U333919E574954D within 150 s." }));
    expect(row.call).toBe("Webhook not delivered:\nPAYMENT.CAPTURE.REFUNDED");
  });
});

describe("traceSegments", () => {
  const path = "POST /v2/checkout/orders/93U333919E574954D/confirm-payment-source";

  it("breaks a path only after a slash, never inside the order id", () => {
    const [segments] = traceSegments(path);
    expect(segments).toEqual(["POST /", "v2/", "checkout/", "orders/", "93U333919E574954D/", "confirm-payment-source"]);
    expect(segments.some((segment) => segment.includes("93U333919E574954D") && segment !== "93U333919E574954D/")).toBe(false);
  });

  it("joins back to the call unchanged, so a copied id is the id", () => {
    const call = "Webhook delivered:\nPAYMENT.CAPTURE.COMPLETED\nPAYMENT.CAPTURE.REFUNDED";
    expect(traceSegments(path).map((line) => line.join("")).join("\n")).toBe(path);
    expect(traceSegments(call).map((line) => line.join("")).join("\n")).toBe(call);
  });

  it("never breaks inside a number", () => {
    expect(traceSegments("Waited 15.1 s for PayPal webhooks.")).toEqual([["Waited 15.1 s for PayPal webhooks."]]);
  });

  it("puts each event on its own line, breakable after its dots", () => {
    expect(traceSegments("Webhook delivered:\nPAYMENT.CAPTURE.COMPLETED")).toEqual([
      ["Webhook delivered:"],
      ["PAYMENT.", "CAPTURE.", "COMPLETED"],
    ]);
  });
});

describe("the first layer's words", () => {
  const JARGON = /transient|5xx|\bevent\b|webhook|replay|capture|idempoten/i;
  // Every headline an assertion can write: the string literals that follow "headline:" or end a pass().
  const source = readFileSync("lib/proof/assertions/index.ts", "utf8");
  const written = [
    ...[...source.matchAll(/headline: "([^"]+)"/g)].map((match) => match[1]),
    ...[...source.matchAll(/\n\s+"([A-Z][^"]{3,60})",\n\s+\);/g)].map((match) => match[1]),
    ...[...source.matchAll(/, "([A-Z][^"]{3,60})"\);/g)].map((match) => match[1]),
  ];

  it("finds the headlines the assertions write", () => {
    expect(written).toContain("Sale lost on a transient error");
    expect(written).toContain("Forged event rejected");
    expect(written).toContain("Decline shown, nothing charged");
    expect(written.length).toBeGreaterThan(20);
  });

  it("shows every headline without a technical word", () => {
    for (const headline of [...written, ...Object.values(FALLBACK_HEADLINES).flatMap((pair) => [pair.PASS, pair.FAIL])]) {
      expect(plainHeadline(headline)).not.toMatch(JARGON);
    }
    expect(plainHeadline("Sale lost on a transient error")).toBe("Sale lost on a temporary error");
    expect(plainHeadline("Buyer charged twice")).toBe("Buyer charged twice");
  });

  it("names each scenario and each store in plain words", () => {
    expect(Object.keys(SCENARIO_TITLES)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
    for (const title of Object.values(SCENARIO_TITLES)) expect(title).not.toMatch(JARGON);
    expect(MODE_LABELS.naive.name).toBe("Naive store");
    expect(MODE_LABELS.hardened.name).toBe("Hardened store");
  });
});
