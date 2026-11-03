// Database reads and writes for proof runs. Orchestration lives in runner.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  runs,
  runScenarios,
  traceSteps,
  type RunRow,
  type RunScenarioRow,
  type StoreMode,
  type TraceStepRow,
} from "../db/schema";
import type { ScenarioId } from "./scenarios";
import type { Actor } from "./types";

/** Rule 7: one run at a time, and a bounded number per hour. */
export const MAX_RUNS_PER_HOUR = 20;
/** A run still active after this long lost its process, for example in a restart. */
const ABANDONED_AFTER_MS = 10 * 60_000;
/** Any constant works; it only has to be the same for every caller. */
const RUN_LOCK_KEY = 7_302_611;

const ACTIVE_RUN = ["QUEUED", "RUNNING"] as const;
const ACTIVE_SCENARIO = ["RUNNING", "WAITING_FOR_WEBHOOK"] as const;

export type CreateRunResult =
  | { kind: "created"; run: RunRow; scenarios: RunScenarioRow[] }
  | { kind: "busy"; runId: string }
  | { kind: "rate_limited"; retryAfterSeconds: number };

/** Creates a run and one row per scenario, each with its own cart, unless the limits say no. */
export async function createRun(mode: StoreMode, scenarioIds: readonly ScenarioId[]): Promise<CreateRunResult> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${RUN_LOCK_KEY})`);

    const abandonedBefore = new Date(Date.now() - ABANDONED_AFTER_MS);
    const abandoned = await tx
      .update(runs)
      .set({ status: "ERROR", error: "The run stopped before it finished.", finishedAt: new Date() })
      .where(and(inArray(runs.status, ACTIVE_RUN), lt(runs.createdAt, abandonedBefore)))
      .returning({ id: runs.id });
    if (abandoned.length > 0) {
      await tx
        .update(runScenarios)
        .set({ status: "ERROR", error: "The run stopped before this scenario finished.", finishedAt: new Date() })
        .where(
          and(
            inArray(
              runScenarios.runId,
              abandoned.map((run) => run.id),
            ),
            inArray(runScenarios.status, ["QUEUED", ...ACTIVE_SCENARIO]),
          ),
        );
    }

    const [active] = await tx.select({ id: runs.id }).from(runs).where(inArray(runs.status, ACTIVE_RUN)).limit(1);
    if (active) return { kind: "busy", runId: active.id };

    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const recent = await tx
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(gt(runs.createdAt, hourAgo))
      .orderBy(asc(runs.createdAt));
    if (recent.length >= MAX_RUNS_PER_HOUR) {
      const freesAt = recent[recent.length - MAX_RUNS_PER_HOUR].createdAt.getTime() + 60 * 60_000;
      return { kind: "rate_limited", retryAfterSeconds: Math.max(1, Math.ceil((freesAt - Date.now()) / 1000)) };
    }

    const [run] = await tx.insert(runs).values({ mode, scenarioIds: [...scenarioIds] }).returning();
    const scenarios = await tx
      .insert(runScenarios)
      .values(
        scenarioIds.map((scenarioId) => ({
          runId: run.id,
          scenarioId,
          cartId: `cart-${randomUUID()}`,
          runKey: randomBytes(32).toString("hex"),
        })),
      )
      .returning();
    return { kind: "created", run, scenarios };
  });
}

export async function markRunStarted(runId: string): Promise<{ run: RunRow; scenarios: RunScenarioRow[] }> {
  const db = getDb();
  const [run] = await db
    .update(runs)
    .set({ status: "RUNNING", startedAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, "QUEUED")))
    .returning();
  if (!run) throw new Error(`Run ${runId} is not queued`);
  const scenarios = await db.select().from(runScenarios).where(eq(runScenarios.runId, runId));
  return { run, scenarios };
}

export async function markRunFinished(runId: string, error: string | null): Promise<void> {
  await getDb()
    .update(runs)
    .set({ status: error ? "ERROR" : "COMPLETED", error, finishedAt: new Date() })
    .where(eq(runs.id, runId));
}

export async function updateScenario(
  runId: string,
  scenarioId: string,
  values: Partial<Pick<RunScenarioRow, "status" | "verdict" | "reason" | "error" | "startedAt" | "finishedAt">>,
): Promise<void> {
  await getDb()
    .update(runScenarios)
    .set(values)
    .where(and(eq(runScenarios.runId, runId), eq(runScenarios.scenarioId, scenarioId)));
}

/** The scenario a cart belongs to, with its key, while that scenario is running. */
export async function findActiveScenario(
  runId: string,
  cartId: string,
): Promise<{ scenarioId: string; runKey: string } | undefined> {
  const [row] = await getDb()
    .select({ scenarioId: runScenarios.scenarioId, runKey: runScenarios.runKey })
    .from(runScenarios)
    .where(
      and(
        eq(runScenarios.runId, runId),
        eq(runScenarios.cartId, cartId),
        inArray(runScenarios.status, ACTIVE_SCENARIO),
      ),
    );
  return row;
}

/** Hands out the scenario's next step number. Steps take one when they start. */
export async function nextSeq(runId: string, scenarioId: string): Promise<number> {
  const [row] = await getDb()
    .update(runScenarios)
    .set({ lastSeq: sql`${runScenarios.lastSeq} + 1` })
    .where(and(eq(runScenarios.runId, runId), eq(runScenarios.scenarioId, scenarioId)))
    .returning({ seq: runScenarios.lastSeq });
  if (!row) throw new Error(`Scenario ${scenarioId} of run ${runId} does not exist`);
  return row.seq;
}

/**
 * One round trip for the proxy: finds the running scenario that holds this key, takes a step number
 * and, for a capture, counts the attempt. Null when no running scenario holds the key.
 */
export async function claimProxyStep(
  runId: string,
  runKey: string,
  isCapture: boolean,
): Promise<{ scenarioId: string; seq: number; captureAttempt: number } | null> {
  const [row] = await getDb()
    .update(runScenarios)
    .set({
      lastSeq: sql`${runScenarios.lastSeq} + 1`,
      captureAttempts: sql`${runScenarios.captureAttempts} + ${isCapture ? 1 : 0}`,
    })
    .where(
      and(
        eq(runScenarios.runId, runId),
        eq(runScenarios.runKey, runKey),
        inArray(runScenarios.status, ACTIVE_SCENARIO),
      ),
    )
    .returning({
      scenarioId: runScenarios.scenarioId,
      seq: runScenarios.lastSeq,
      captureAttempt: runScenarios.captureAttempts,
    });
  return row ?? null;
}

export interface StepRecord {
  actor: Actor;
  startedAt: Date;
  durationMs: number;
  method?: string | null;
  path?: string | null;
  httpStatus?: number | null;
  debugId?: string | null;
  paypalRequestId?: string | null;
  fault?: string | null;
  /** Redacted before it gets here. */
  requestBody?: unknown;
  /** Redacted before it gets here. */
  responseBody?: unknown;
  note?: string | null;
}

export async function writeStep(runId: string, scenarioId: string, seq: number, step: StepRecord): Promise<void> {
  await getDb()
    .insert(traceSteps)
    .values({
      runId,
      scenarioId,
      seq,
      actor: step.actor,
      startedAt: step.startedAt,
      durationMs: step.durationMs,
      method: step.method ?? null,
      path: step.path ?? null,
      httpStatus: step.httpStatus ?? null,
      debugId: step.debugId ?? null,
      paypalRequestId: step.paypalRequestId ?? null,
      fault: step.fault ?? null,
      requestBody: step.requestBody ?? null,
      responseBody: step.responseBody ?? null,
      note: step.note ?? null,
    });
}

export async function readTrace(runId: string, scenarioId?: string): Promise<TraceStepRow[]> {
  const conditions = [eq(traceSteps.runId, runId)];
  if (scenarioId) conditions.push(eq(traceSteps.scenarioId, scenarioId));
  return getDb()
    .select()
    .from(traceSteps)
    .where(and(...conditions))
    .orderBy(asc(traceSteps.scenarioId), asc(traceSteps.seq));
}

export async function readRun(runId: string): Promise<{ run: RunRow; scenarios: RunScenarioRow[] } | null> {
  const db = getDb();
  const [run] = await db.select().from(runs).where(eq(runs.id, runId));
  if (!run) return null;
  const scenarios = await db
    .select()
    .from(runScenarios)
    .where(eq(runScenarios.runId, runId))
    .orderBy(asc(runScenarios.scenarioId));
  return { run, scenarios };
}

export async function listRuns(limit: number): Promise<(RunRow & { passed: number; failed: number })[]> {
  const db = getDb();
  const rows = await db.select().from(runs).orderBy(desc(runs.createdAt)).limit(limit);
  if (rows.length === 0) return [];
  const verdicts = await db
    .select({ runId: runScenarios.runId, verdict: runScenarios.verdict, total: count() })
    .from(runScenarios)
    .where(
      inArray(
        runScenarios.runId,
        rows.map((row) => row.id),
      ),
    )
    .groupBy(runScenarios.runId, runScenarios.verdict);
  const tally = (runId: string, verdict: "PASS" | "FAIL") =>
    verdicts.find((row) => row.runId === runId && row.verdict === verdict)?.total ?? 0;
  return rows.map((row) => ({ ...row, passed: tally(row.id, "PASS"), failed: tally(row.id, "FAIL") }));
}
