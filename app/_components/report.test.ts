import { describe, expect, it } from "vitest";
import {
  cellState,
  progressLabel,
  repeatedRequestIds,
  retriedWithSameKey,
  runDate,
  shortRequestId,
  traceRow,
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
});
