// What makes two failures "the same" for the analysis cache: the same scenario, the same store code
// and a trace that behaves the same way. Ids, times, durations and debug ids differ between runs and
// are left out; methods, paths, statuses, faults and the outcomes in the bodies stay in.
import { createHash } from "node:crypto";
import { z } from "zod";

/** PayPal order and capture ids, webhook event ids, and uuids such as run and cart ids. */
const VOLATILE_IDS = [
  /WH-[A-Z0-9]+(?:-[A-Z0-9]+)*/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b[A-Z0-9]{17}\b/g,
];

export function normalizeIds(text: string): string {
  return VOLATILE_IDS.reduce((value, pattern) => value.replace(pattern, "<id>"), text);
}

/** PayPal ids and event ids found in a text, so the analysis can be kept free of them. */
export function volatileIds(text: string): string[] {
  const [events, , paypalIds] = VOLATILE_IDS;
  const found = new Set(text.match(events) ?? []);
  // An event id contains 17-character parts of its own; only ids outside event ids count as orders.
  for (const match of text.replace(events, " ").matchAll(paypalIds)) found.add(match[0]);
  return [...found];
}

export interface SignatureStep {
  seq: number;
  actor: string;
  method: string | null;
  path: string | null;
  httpStatus: number | null;
  fault: string | null;
  responseBody: unknown;
}

const OutcomeSchema = z
  .object({
    status: z.string().optional(),
    outcome: z.string().optional(),
    verification: z.string().optional(),
    name: z.string().optional(),
    details: z.array(z.object({ issue: z.string().optional() })).optional(),
  })
  .partial();

function outcomeOf(body: unknown) {
  const parsed = OutcomeSchema.safeParse(body).data;
  if (!parsed) return null;
  return {
    status: parsed.status ?? null,
    outcome: parsed.outcome ?? null,
    verification: parsed.verification ?? null,
    name: parsed.name ?? null,
    issues: (parsed.details ?? []).map((detail) => detail.issue ?? null),
  };
}

export function traceSignature(steps: SignatureStep[], verdict: string, reason: string): string {
  const shape = steps.map((step) => ({
    seq: step.seq,
    actor: step.actor,
    method: step.method,
    path: step.path ? normalizeIds(step.path.split("?")[0]) : null,
    httpStatus: step.httpStatus,
    fault: step.fault,
    outcome: outcomeOf(step.responseBody),
  }));
  return sha256(JSON.stringify({ verdict, reason: normalizeIds(reason), shape }));
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * The format of an analysis. 2: the fix is edits that code applies and turns into a diff; analyses
 * of format 1 carried a model-written diff and are not reused.
 */
export const ANALYSIS_FORMAT = 2;

/** The analysis cache key. The model is part of it: another model writes another analysis. */
export function analysisKey(parts: { scenarioId: string; model: string; codeHash: string; traceSignature: string }): string {
  return sha256(JSON.stringify([ANALYSIS_FORMAT, parts.scenarioId, parts.model, parts.codeHash, parts.traceSignature]));
}
