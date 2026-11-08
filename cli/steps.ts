// One step of a CLI run's trace: every request the buyer, the store and the CLI made, in order.
import type { Actor, TraceEntry } from "../lib/proof/types";

export interface CliStep {
  actor: Actor;
  /** Where the request went; the assertions tell the buyer's store requests from PayPal calls by it. */
  target: "store" | "paypal";
  startedAt: string;
  durationMs: number;
  method: string;
  /** For the store, the path under the store's own origin; for PayPal, the API path. */
  path: string;
  httpStatus: number | null;
  debugId: string | null;
  paypalRequestId: string | null;
  fault: string | null;
  /** Bodies are redacted before they are kept (lib/proof/redact.ts). */
  requestBody: unknown;
  responseBody: unknown;
  note: string | null;
  /** When the request started, on the process's monotonic clock: the trace is ordered by it. */
  startMs: number;
}

export interface NumberedStep extends Omit<CliStep, "startMs"> {
  seq: number;
}

/**
 * Steps in the order their requests started, numbered from 1. Steps are recorded when their answer
 * arrives, so a store's PayPal call would otherwise come before the buyer's request that caused it.
 */
export function numbered(steps: CliStep[]): NumberedStep[] {
  return steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => a.step.startMs - b.step.startMs || a.index - b.index)
    .map(({ step }, index) => {
      const { startMs: _startMs, ...rest } = step;
      void _startMs;
      return { ...rest, seq: index + 1 };
    });
}

/** The part of a step the assertions read. */
export function toEntry(step: NumberedStep): TraceEntry {
  return {
    seq: step.seq,
    actor: step.actor,
    method: step.method,
    path: step.path,
    httpStatus: step.httpStatus,
    fault: step.fault,
    responseBody: step.responseBody,
    target: step.target,
  };
}
