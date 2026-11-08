import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFixtureStore, type FixtureOptions } from "./fixture-store";
import { installModel } from "./model";
import { startProxy, type LocalProxy } from "./proxy";
import { buildReport, consoleLines, markdown, parseExpectations } from "./report";
import { runScenarios, type ScenarioResult } from "./run";

// Short enough to keep the tests quick, with the hold longer than the store's timeout as S3 needs.
const HOLD_MS = 600;
const STORE_TIMEOUT_MS = 200;

let model: ReturnType<typeof installModel>;
let proxy: LocalProxy;

beforeAll(async () => {
  process.env.PAYPAL_API_BASE = "https://api-m.sandbox.paypal.com";
  model = installModel();
  proxy = await startProxy({ port: 0, holdMs: HOLD_MS });
});

afterAll(async () => {
  await proxy.close();
  model.restore();
});

async function prove(store: Omit<FixtureOptions, "paypalBase">): Promise<Record<string, ScenarioResult>> {
  const fixture = await startFixtureStore({ ...store, paypalBase: proxy.url });
  try {
    const results = await runScenarios({
      store: new URL(fixture.url),
      scenarios: ["S1", "S2", "S3"],
      proxy,
      holdMs: HOLD_MS,
      buyerTimeoutMs: 5_000,
    });
    return Object.fromEntries(results.map((result) => [result.id, result]));
  } finally {
    await fixture.close();
  }
}

describe("integration-proof run, against a store that implements the contract", () => {
  it("passes a store that retries a 5xx and asks PayPal after a timeout", async () => {
    const results = await prove({ retriesTransientErrors: true, asksPayPalAfterTimeout: true, timeoutMs: STORE_TIMEOUT_MS });
    expect(Object.values(results).map((result) => [result.id, result.verdict])).toEqual([
      ["S1", "PASS"],
      ["S2", "PASS"],
      ["S3", "PASS"],
    ]);
    expect(model.model.violations).toEqual([]);
  });

  it("fails each mistake in the scenario about it, with the same reasons as the hosted proof", async () => {
    const results = await prove({ retriesTransientErrors: false, asksPayPalAfterTimeout: false, timeoutMs: STORE_TIMEOUT_MS });
    expect(results.S1.verdict).toBe("PASS");
    expect(results.S2).toMatchObject({ verdict: "FAIL", headline: "Sale lost on a transient error", harm: "sale_lost" });
    expect(results.S3).toMatchObject({ verdict: "FAIL", headline: "Buyer charged twice", harm: "cart_charged_twice" });
    expect(results.S3.reason).toContain("The buyer checked out 2 times.");
  });

  it("records the store's requests under its own prefix, and the proxy's faults on its PayPal calls", async () => {
    const results = await prove({ retriesTransientErrors: false, asksPayPalAfterTimeout: false, timeoutMs: STORE_TIMEOUT_MS });
    const s3 = results.S3.steps;
    expect(s3.filter((step) => step.actor === "buyer" && step.target === "store").map((step) => step.path)).toEqual([
      "/integration-proof/orders",
      expect.stringMatching(/^\/integration-proof\/orders\/[A-Z0-9]+\/capture$/),
      "/integration-proof/orders",
      expect.stringMatching(/^\/integration-proof\/orders\/[A-Z0-9]+\/capture$/),
    ]);
    expect(s3.find((step) => step.actor === "store" && step.fault)?.fault).toBe(`Response held ${HOLD_MS} ms`);
    expect(results.S2.steps.find((step) => step.actor === "store" && step.fault)?.fault).toBe("PayPal-Mock-Response INTERNAL_SERVER_ERROR");
    // The buyer's own PayPal call is recorded as going to PayPal.
    expect(s3.some((step) => step.actor === "buyer" && step.target === "paypal" && step.path.endsWith("/confirm-payment-source"))).toBe(true);
  });

  it("calls S3 inconclusive when the store waits out the held answer instead of timing out", async () => {
    const results = await prove({ retriesTransientErrors: true, asksPayPalAfterTimeout: false, timeoutMs: null });
    expect(results.S3).toMatchObject({ verdict: "INCONCLUSIVE", headline: "Lost response not tested" });
    expect(results.S3.reason).toContain(`shorter than --hold-ms (${HOLD_MS} ms)`);
  });
});

describe("the contract", () => {
  it("stops a scenario with the contract's words when the store answers out of contract", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "not-an-order" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    try {
      const [result] = await runScenarios({ store: new URL(`http://127.0.0.1:${port}/shop`), scenarios: ["S1"], proxy, holdMs: HOLD_MS, buyerTimeoutMs: 2_000 });
      expect(result).toMatchObject({ verdict: "ERROR", headline: "Could not run" });
      expect(result.reason).toContain('contract v1 expects 201 and {"orderId": "..."}');
      expect(result.steps[0]).toMatchObject({ actor: "buyer", target: "store", path: "/shop/orders", httpStatus: 200 });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

describe("the local proxy", () => {
  it("forwards only the OAuth token and the Orders v2 create, get and capture calls", async () => {
    const before = model.model.violations.length;
    for (const [method, path] of [
      ["POST", "/v2/payments/captures/C1/refund"],
      ["POST", "/v2/checkout/orders/O1/authorize"],
      ["POST", "/v1/notifications/verify-webhook-signature"],
      ["GET", "/v1/identity/oauth2/userinfo"],
    ]) {
      const response = await fetch(`${proxy.url}${path}`, { method, body: method === "POST" ? "{}" : undefined });
      expect(response.status).toBe(404);
      expect(((await response.json()) as { name: string }).name).toBe("NOT_PROXIED");
    }
    // Nothing reached PayPal, so the model saw no call it does not cover.
    expect(model.model.violations.length).toBe(before);
  });

  it("listens on the loopback interface only", () => {
    expect(new URL(proxy.url).hostname).toBe("127.0.0.1");
  });
});

describe("report", () => {
  const scenario = (id: "S1" | "S2" | "S3", verdict: ScenarioResult["verdict"]): ScenarioResult => ({
    id,
    title: id,
    passWhen: "",
    verdict,
    headline: "h",
    reason: "r | with a pipe",
    harm: null,
    durationMs: 1,
    steps: [],
  });
  const base = { store: "http://127.0.0.1:4000/integration-proof", paypal: "model" as const, holdMs: 600, startedAt: "", durationMs: 1000 };

  it("is as expected when every verdict matches --expect, and otherwise when every scenario passed", () => {
    const expected = parseExpectations("S1=PASS, s2=fail");
    expect(expected).toEqual({ S1: "PASS", S2: "FAIL" });
    expect(buildReport({ ...base, expected, scenarios: [scenario("S1", "PASS"), scenario("S2", "FAIL")] }).ok).toBe(true);
    expect(buildReport({ ...base, expected, scenarios: [scenario("S1", "PASS"), scenario("S2", "PASS")] }).ok).toBe(false);
    expect(buildReport({ ...base, expected: {}, scenarios: [scenario("S1", "PASS"), scenario("S3", "INCONCLUSIVE")] }).ok).toBe(false);
  });

  it("counts the verdicts on its last line without --expect, and keeps the exit status", () => {
    const report = buildReport({
      ...base,
      expected: {},
      scenarios: [scenario("S1", "PASS"), scenario("S2", "FAIL"), scenario("S3", "FAIL")],
    });
    expect(report.ok).toBe(false);
    const last = consoleLines(report).at(-1);
    expect(last).toBe("Result: 1 passed, 2 failed, 0 inconclusive.");
    expect(consoleLines(report).join("\n")).not.toMatch(/expected/);
    expect(markdown(report)).toContain("1 passed, 2 failed, 0 inconclusive. The full trace of every scenario is in report.json.");
    expect(markdown(report)).not.toMatch(/expected/i);

    const passed = buildReport({ ...base, expected: {}, scenarios: [scenario("S1", "PASS"), scenario("S2", "PASS"), scenario("S3", "PASS")] });
    expect(passed.ok).toBe(true);
    expect(consoleLines(passed).at(-1)).toBe("Result: 3 passed, 0 failed, 0 inconclusive.");

    const errored = buildReport({ ...base, expected: {}, scenarios: [scenario("S1", "PASS"), scenario("S2", "ERROR"), scenario("S3", "INCONCLUSIVE")] });
    expect(errored.ok).toBe(false);
    expect(consoleLines(errored).at(-1)).toBe("Result: 1 passed, 0 failed, 1 inconclusive, 1 could not run.");
  });

  it("keeps the wording of --expect", () => {
    const scenarios = [scenario("S1", "PASS"), scenario("S2", "FAIL"), scenario("S3", "FAIL")];
    const asExpected = buildReport({ ...base, expected: parseExpectations("S1=PASS,S2=FAIL,S3=FAIL"), scenarios });
    expect(consoleLines(asExpected).at(-1)).toBe("Result: every scenario as expected.");
    expect(markdown(asExpected)).toContain("Every scenario as expected.");
    const notAsExpected = buildReport({ ...base, expected: parseExpectations("S1=PASS,S2=PASS,S3=PASS"), scenarios });
    expect(consoleLines(notAsExpected).at(-1)).toBe("Result: not as expected.");
    expect(markdown(notAsExpected)).toContain("**Not as expected.**");
  });

  it("shows a headline in the site's words on the console and in summary.md, and keeps it raw in report.json", () => {
    const report = buildReport({
      ...base,
      expected: {},
      scenarios: [{ ...scenario("S2", "FAIL"), headline: "Sale lost on a transient error" }],
    });
    expect(consoleLines(report)[0]).toContain("Sale lost on a temporary error");
    expect(markdown(report)).toContain("| Sale lost on a temporary error |");
    expect(`${consoleLines(report).join("\n")}\n${markdown(report)}`).not.toMatch(/transient/);
    expect(JSON.parse(JSON.stringify(report)).scenarios[0].headline).toBe("Sale lost on a transient error");
  });

  it("rejects an expectation outside contract v1", () => {
    expect(() => parseExpectations("S4=PASS")).toThrow(/S1..S3/);
    expect(() => parseExpectations("S1=MAYBE")).toThrow();
  });

  it("writes a Markdown table a CI job page can show", () => {
    const text = markdown(buildReport({ ...base, expected: { S1: "PASS" }, scenarios: [scenario("S1", "PASS")] }));
    expect(text).toContain("| Scenario | Verdict | What happened | Why | Expected |");
    expect(text).toContain("| S1 · S1 | **PASS** | h | r \\| with a pipe | as expected |");
    expect(text).toContain("offline model of the sandbox");
  });
});
