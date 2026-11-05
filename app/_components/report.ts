// Shapes of the runs API on the client, and the small pure helpers the result views share.
import type { Snippet } from "@/lib/store/snippets";

export type Mode = "naive" | "hardened";
export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE";

export interface StepView {
  id: string;
  seq: number;
  actor: string;
  startedAt: string;
  durationMs: number;
  method: string | null;
  path: string | null;
  httpStatus: number | null;
  debugId: string | null;
  paypalRequestId: string | null;
  fault: string | null;
  note: string | null;
}

export interface AnalysisResult {
  rootCause: string;
  businessImpact: string;
  evidence: { stepId: number; observation: string }[];
  fix: {
    summary: string;
    /** The unified diff, built by the server from Claude's edits. Empty when they did not match. */
    patch: string;
    edits?: { file: string; find: string; replace: string }[];
    /** checks: self-check rounds used, 0 or 1; matched: whether the edits matched the file in the end. */
    selfCheck?: { checks: number; matched: boolean };
    docs: { title: string; url: string }[];
  };
  verifyBy: string;
  confidence: "low" | "medium" | "high";
}

export interface AnalysisView {
  status: "PENDING" | "READY" | "UNAVAILABLE";
  reused: boolean;
  model: string;
  durationMs: number | null;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  result: AnalysisResult | null;
  patchStatus: "applies" | "needs_review" | "none" | null;
  patchNote: string | null;
  /** The offline check of this exact patch: docs/ai-fixes-report.md. */
  fixCheck?: { verified: boolean; before: string | null; after: string | null; reason: string | null; report: string } | null;
  error: string | null;
}

export interface ScenarioView {
  id: string;
  title: string;
  passWhen: string | null;
  status: "QUEUED" | "RUNNING" | "WAITING_FOR_WEBHOOK" | "COMPLETED" | "ERROR";
  statusLabel: string;
  waitingSince: string | null;
  verdict: Verdict | null;
  reason: string | null;
  headline: string | null;
  harm: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  analysis: AnalysisView | null;
  steps?: StepView[];
}

export interface RunReport {
  id: string;
  mode: Mode;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "ERROR";
  error: string | null;
  summary: { total: number; passed: number; failed: number; inconclusive: number; errors: number };
  /** What the run's failures cost, counted and worded by the server: "1 cart charged twice". */
  consequences: string[];
  config: { storeTimeoutMs: number; proxyHoldMs: number; webhookDeadlineMs: number; freshAnalysis: boolean };
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  scenarios: ScenarioView[];
}

/** Six scenarios, in order, so a column has its rows before a run has any. */
export const SCENARIO_TITLES: Record<string, string> = {
  S1: "Capture declined",
  S2: "Transient 5xx on capture",
  S3: "Lost response after a successful capture",
  S4: "Duplicate webhook",
  S5: "Late redelivery of COMPLETED after a refund",
  S6: "Forged webhook",
};

/**
 * Headlines for runs recorded before the assertions wrote their own. New runs carry a headline
 * derived from the same facts as the verdict, which these only stand in for.
 */
export const FALLBACK_HEADLINES: Record<string, { PASS: string; FAIL: string }> = {
  S1: { PASS: "Decline shown, nothing charged", FAIL: "Declined capture mishandled" },
  S2: { PASS: "Retried and charged once", FAIL: "Sale lost on a transient error" },
  S3: { PASS: "Charged once, no second checkout", FAIL: "Buyer charged twice" },
  S4: { PASS: "Shipped once", FAIL: "Order shipped twice" },
  S5: { PASS: "Shows refunded, as PayPal does", FAIL: "Refunded order shown as paid" },
  S6: { PASS: "Forged event rejected", FAIL: "Forged refund accepted" },
};

/**
 * The marked lines of both store files, read on the server, and the commit they come from, so a
 * link opens the same lines in the repository.
 */
export interface StoreCode {
  ref: string;
  snippets: Partial<Record<Mode, Record<string, Snippet>>>;
}

export type Tone = "pass" | "fail" | "warn";

/** A verdict as a color: PASS green, FAIL red, INCONCLUSIVE amber. ERROR and no verdict have none. */
export function verdictTone(verdict: Verdict | null): Tone | null {
  return verdict === "PASS" ? "pass" : verdict === "FAIL" ? "fail" : verdict === "INCONCLUSIVE" ? "warn" : null;
}

/**
 * A finished run as a color: red with any failure, green when every scenario passed, amber when
 * something could not be judged. Nothing while the run is in progress.
 */
export function runTone(report: RunReport | null): Tone | null {
  if (!report || isRunActive(report)) return null;
  if (report.summary.failed > 0) return "fail";
  if (report.status === "COMPLETED" && report.summary.passed === report.summary.total) return "pass";
  return "warn";
}

/** How Claude's edits met the store file, in a few words for the analysis header. */
export function selfCheckLabel(selfCheck: AnalysisResult["fix"]["selfCheck"]): string | null {
  if (!selfCheck) return null;
  if (!selfCheck.matched) return `edits did not match after ${selfCheck.checks} check`;
  return selfCheck.checks === 0 ? "edits matched on the first check" : `self-corrected after ${selfCheck.checks} check`;
}

/**
 * Edits that did not match the file, as diff-like lines for review: each find as removed lines and
 * its replace as added ones. Not a patch; nothing applies it.
 */
export function proposedEdits(edits: NonNullable<AnalysisResult["fix"]["edits"]>): string {
  return edits
    .map((edit, index) =>
      [
        `@@ edit ${index + 1} of ${edits.length}, not applied: ${edit.file} @@`,
        ...edit.find.split("\n").map((line) => `-${line}`),
        ...edit.replace.split("\n").map((line) => `+${line}`),
      ].join("\n"),
    )
    .join("\n");
}

/**
 * The live label of a scenario waiting for PayPal's webhooks. The count never passes the limit: once
 * the wait is over the runner records the result within seconds, and a run whose process died is
 * ended by the server, so the card says what it is waiting for instead of counting on.
 */
export function waitLabel(waitedMs: number, limitMs: number): string {
  const limit = Math.round(limitMs / 1000);
  if (waitedMs >= limitMs) return `PayPal did not deliver within ${limit} s · recording the result`;
  return `Waiting for PayPal webhook · ${Math.max(0, Math.floor(waitedMs / 1000))} s of ${limit} s`;
}

export const MODE_LABELS: Record<Mode, { name: string; blurb: string }> = {
  naive: { name: "Naive store", blurb: "The common integration mistakes, left in." },
  hardened: { name: "Hardened store", blurb: "The same store with each mistake fixed." },
};

export function isRunActive(report: RunReport | null): boolean {
  return report !== null && (report.status === "QUEUED" || report.status === "RUNNING");
}

/** How long the page keeps waiting for analyses once a run has finished. */
const ANALYSIS_WAIT_MS = 10 * 60_000;

/** Nothing more will change: the run is over and every failure has its analysis or never will. */
export function isSettled(report: RunReport, now = Date.now()): boolean {
  if (isRunActive(report)) return false;
  const finished = report.finishedAt ? Date.parse(report.finishedAt) : now;
  if (now - finished > ANALYSIS_WAIT_MS) return true;
  return report.scenarios.every(
    (scenario) =>
      (scenario.verdict !== "FAIL" && scenario.verdict !== "INCONCLUSIVE") ||
      (scenario.analysis !== null && scenario.analysis.status !== "PENDING"),
  );
}

export function seconds(ms: number | null): string {
  if (ms === null) return "–";
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

export function timeAgo(iso: string, now: number): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric" });
}

export type TraceActor = "buyer" | "store" | "proxy" | "PayPal" | "runner" | "Claude";

export interface TraceRow {
  seq: number;
  actor: TraceActor;
  call: string;
  httpStatus: number | null;
  durationMs: number;
  debugId: string | null;
  detail: string | null;
}

/** The path without its query string, which only carries ids. */
function shortPath(path: string): string {
  return path.split("?")[0];
}

const DELIVERED = /(PAYMENT\.CAPTURE\.[A-Z]+) for order \S+ acknowledged/g;
const MISSING = /No acknowledged (PAYMENT\.CAPTURE\.[A-Z]+)/g;

/**
 * One trace step as a reader would describe it. The store's PayPal calls pass the proxy; a call
 * the proxy faulted is shown as the proxy's. The runner's wait for webhooks shows PayPal's
 * deliveries, which have no request line of their own.
 */
export function traceRow(step: StepView): TraceRow {
  const base = { seq: step.seq, httpStatus: step.httpStatus, durationMs: step.durationMs, debugId: step.debugId };
  const request = step.method && step.path ? `${step.method} ${shortPath(step.path)}` : null;

  if (step.actor === "analyst") {
    return { ...base, actor: "Claude", call: request ?? "Analysis reused from the cache", detail: step.note };
  }
  if (step.actor === "store") {
    return { ...base, actor: step.fault ? "proxy" : "store", call: request ?? "PayPal call", detail: step.fault ?? step.note };
  }
  if (step.actor === "runner" && !request) {
    const delivered = [...(step.note ?? "").matchAll(DELIVERED)].map((match) => match[1]);
    const missing = [...(step.note ?? "").matchAll(MISSING)].map((match) => match[1]);
    const call =
      missing.length > 0
        ? `Webhook not delivered: ${missing.join(", ")}`
        : delivered.length > 0
          ? `Webhook delivered: ${delivered.join(", ")}`
          : "Waited for PayPal webhooks";
    return { ...base, actor: "PayPal", call, detail: step.note };
  }
  const actor: TraceActor = step.actor === "buyer" ? "buyer" : "runner";
  return { ...base, actor, call: request ?? "Step", detail: step.fault ?? step.note };
}
