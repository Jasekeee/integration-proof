// Database reads and writes for proof runs. Orchestration lives in runner.ts.
import { randomBytes, randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { getDb, type Database } from "../db/client";
import {
  runs,
  runScenarios,
  traceSteps,
  webhookDeliveries,
  type RunRow,
  type RunScenarioRow,
  type StoreMode,
  type TraceStepRow,
} from "../db/schema";
import { runsPerHour, runsPerVisitorPerHour } from "./limits";
import { INTERRUPTED_HEADLINE, INTERRUPTED_REASON, LEASE_MS, OVERDUE_REASON, RUN_LIMIT_MS } from "./lease";
import type { ScenarioId } from "./scenarios";
import type { Actor } from "./types";

/** Any constant works; it only has to be the same for every caller. */
const RUN_LOCK_KEY = 7_302_611;

const ACTIVE_RUN = ["QUEUED", "RUNNING"] as const;
const ACTIVE_SCENARIO = ["RUNNING", "WAITING_FOR_WEBHOOK"] as const;

export type CreateRunResult =
  | { kind: "created"; run: RunRow; scenarios: RunScenarioRow[] }
  | { kind: "busy"; runId: string }
  /** visitor: this visitor's hourly runs are used up; everyone: all visitors' together are. */
  | { kind: "rate_limited"; scope: "visitor" | "everyone"; limit: number; retryAfterSeconds: number };

export interface RunConfig {
  storeTimeoutMs: number;
  proxyHoldMs: number;
  freshAnalysis: boolean;
}

type Executor = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Ends the given runs, which no process is working on any more. Their scenarios that had finished
 * keep their verdicts; the others end INCONCLUSIVE with the reason, never FAIL or PASS, because the
 * store was never fully tested. Returns the ids of the runs it ended.
 */
async function endRuns(db: Executor, where: SQL, reason: string, now: Date): Promise<string[]> {
  const ended = await db
    .update(runs)
    .set({ status: "COMPLETED", error: reason, finishedAt: now })
    .where(and(inArray(runs.status, ACTIVE_RUN), where))
    .returning({ id: runs.id });
  if (ended.length === 0) return [];
  await db
    .update(runScenarios)
    .set({
      status: "COMPLETED",
      verdict: "INCONCLUSIVE",
      reason,
      headline: INTERRUPTED_HEADLINE,
      harm: null,
      waitingSince: null,
      finishedAt: now,
    })
    .where(
      and(
        inArray(
          runScenarios.runId,
          ended.map((run) => run.id),
        ),
        inArray(runScenarios.status, ["QUEUED", ...ACTIVE_SCENARIO]),
      ),
    );
  return ended.map((run) => run.id);
}

/**
 * Ends every run whose lease has lapsed or that has run past its limit (lib/proof/lease.ts). The
 * same rule as leaseState, in SQL.
 */
async function recoverIn(db: Executor, now: Date): Promise<string[]> {
  const began = sql`coalesce(${runs.startedAt}, ${runs.createdAt})`;
  const lastSign = sql`coalesce(${runs.lastHeartbeatAt}, ${runs.startedAt}, ${runs.createdAt})`;
  // Lapsed leases first: a run whose process is gone was interrupted, however long ago it began.
  const interrupted = await endRuns(db, sql`${lastSign} < ${new Date(now.getTime() - LEASE_MS)}`, INTERRUPTED_REASON, now);
  const overdue = await endRuns(db, sql`${began} < ${new Date(now.getTime() - RUN_LIMIT_MS)}`, OVERDUE_REASON, now);
  return [...interrupted, ...overdue];
}

/** Ends the runs no process is working on. Safe to call from anywhere, at any time. */
export async function recoverInterruptedRuns(now = new Date()): Promise<string[]> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${RUN_LOCK_KEY})`);
    return recoverIn(tx, now);
  });
}

const RECOVERY_GLOBAL = "integrationProofLastRecovery";
const RECOVERY_EVERY_MS = 5_000;

/**
 * recoverInterruptedRuns on a read path, at most once every few seconds per process, so a page that
 * polls a run never sees an interrupted one as still running. Never throws.
 */
export async function recoverInterruptedRunsLazily(): Promise<void> {
  const store = globalThis as typeof globalThis & { [RECOVERY_GLOBAL]?: number };
  if (Date.now() - (store[RECOVERY_GLOBAL] ?? 0) < RECOVERY_EVERY_MS) return;
  store[RECOVERY_GLOBAL] = Date.now();
  await recoverInterruptedRuns().catch((error: unknown) => console.error("Could not recover interrupted runs", error));
}

/** Ends these runs now, if they are still active: the process running them is shutting down. */
export async function interruptRuns(runIds: string[], now = new Date()): Promise<string[]> {
  if (runIds.length === 0) return [];
  return endRuns(getDb(), inArray(runs.id, runIds), INTERRUPTED_REASON, now);
}

/** Renews the runner's lease. False when the run is no longer running, for example once recovered. */
export async function renewLease(runId: string): Promise<boolean> {
  const renewed = await getDb()
    .update(runs)
    .set({ lastHeartbeatAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, "RUNNING")))
    .returning({ id: runs.id });
  return renewed.length > 0;
}

/** When the oldest of `limit` runs in the last hour turns an hour old, in seconds from now. */
function retryAfter(createdAt: Date[], limit: number, now: number): number {
  const freesAt = createdAt[createdAt.length - limit].getTime() + 60 * 60_000;
  return Math.max(1, Math.ceil((freesAt - now) / 1000));
}

/**
 * Creates a run and one row per scenario, each with its own cart, unless the limits say no
 * (rule 7): one live run at a time, a number of runs per visitor and hour, and a higher number for
 * everyone together. `visitor` is a hash of the visitor's address, or null for scripts and tests.
 */
export async function createRun(
  mode: StoreMode,
  scenarioIds: readonly ScenarioId[],
  config: RunConfig,
  visitor: string | null = null,
): Promise<CreateRunResult> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${RUN_LOCK_KEY})`);

    // "One run at a time" is a lease, not a flag: a run without a process ends here and blocks nothing.
    await recoverIn(tx, new Date());

    const [active] = await tx.select({ id: runs.id }).from(runs).where(inArray(runs.status, ACTIVE_RUN)).limit(1);
    if (active) return { kind: "busy", runId: active.id };

    const now = Date.now();
    const hourAgo = new Date(now - 60 * 60_000);
    if (visitor) {
      const mine = await tx
        .select({ createdAt: runs.createdAt })
        .from(runs)
        .where(and(eq(runs.visitor, visitor), gt(runs.createdAt, hourAgo)))
        .orderBy(asc(runs.createdAt));
      const limit = runsPerVisitorPerHour();
      if (mine.length >= limit) {
        return { kind: "rate_limited", scope: "visitor", limit, retryAfterSeconds: retryAfter(mine.map((row) => row.createdAt), limit, now) };
      }
    }
    const recent = await tx
      .select({ createdAt: runs.createdAt })
      .from(runs)
      .where(gt(runs.createdAt, hourAgo))
      .orderBy(asc(runs.createdAt));
    const limit = runsPerHour();
    if (recent.length >= limit) {
      return { kind: "rate_limited", scope: "everyone", limit, retryAfterSeconds: retryAfter(recent.map((row) => row.createdAt), limit, now) };
    }

    const [run] = await tx.insert(runs).values({ mode, scenarioIds: [...scenarioIds], ...config, visitor }).returning();
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
    .set({ status: "RUNNING", startedAt: new Date(), lastHeartbeatAt: new Date() })
    .where(and(eq(runs.id, runId), eq(runs.status, "QUEUED")))
    .returning();
  if (!run) throw new Error(`Run ${runId} is not queued`);
  const scenarios = await db.select().from(runScenarios).where(eq(runScenarios.runId, runId));
  return { run, scenarios };
}

/** Finishes a run that is still active. A run already ended by recovery stays as it was ended. */
export async function markRunFinished(runId: string, error: string | null): Promise<void> {
  const db = getDb();
  const [finished] = await db
    .update(runs)
    .set({ status: error ? "ERROR" : "COMPLETED", error, finishedAt: new Date() })
    .where(and(eq(runs.id, runId), inArray(runs.status, ACTIVE_RUN)))
    .returning({ id: runs.id });
  if (!finished) return;
  // A scenario that could not record its own result, for example after a lost database
  // connection, must not read as still running once the run is over.
  await db
    .update(runScenarios)
    .set({ status: "ERROR", error: "The run ended before this scenario recorded its result.", finishedAt: new Date() })
    .where(and(eq(runScenarios.runId, runId), inArray(runScenarios.status, ["QUEUED", ...ACTIVE_SCENARIO])));
}

export async function updateScenario(
  runId: string,
  scenarioId: string,
  values: Partial<
    Pick<
      RunScenarioRow,
      | "status"
      | "verdict"
      | "reason"
      | "headline"
      | "harm"
      | "error"
      | "startedAt"
      | "finishedAt"
      | "waitingSince"
    >
  >,
): Promise<void> {
  const db = getDb();
  // Only while the run is running: a process that comes back after its run was ended by recovery
  // must not overwrite the INCONCLUSIVE it was given.
  const running = db.select({ id: runs.id }).from(runs).where(and(eq(runs.id, runId), eq(runs.status, "RUNNING")));
  await db
    .update(runScenarios)
    .set(values)
    .where(and(eq(runScenarios.runId, runId), eq(runScenarios.scenarioId, scenarioId), inArray(runScenarios.runId, running)));
}

/** The scenario a cart belongs to, with its key and the run's store timeout, while it is running. */
export async function findActiveScenario(
  runId: string,
  cartId: string,
): Promise<{ scenarioId: string; runKey: string; storeTimeoutMs: number } | undefined> {
  const [row] = await getDb()
    .select({ scenarioId: runScenarios.scenarioId, runKey: runScenarios.runKey, storeTimeoutMs: runs.storeTimeoutMs })
    .from(runScenarios)
    .innerJoin(runs, eq(runs.id, runScenarios.runId))
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
): Promise<{ scenarioId: string; seq: number; captureAttempt: number; proxyHoldMs: number } | null> {
  const [row] = await getDb()
    .update(runScenarios)
    .set({
      lastSeq: sql`${runScenarios.lastSeq} + 1`,
      captureAttempts: sql`${runScenarios.captureAttempts} + ${isCapture ? 1 : 0}`,
    })
    .from(runs)
    .where(
      and(
        eq(runs.id, runScenarios.runId),
        eq(runScenarios.runId, runId),
        eq(runScenarios.runKey, runKey),
        inArray(runScenarios.status, ACTIVE_SCENARIO),
      ),
    )
    .returning({
      scenarioId: runScenarios.scenarioId,
      seq: runScenarios.lastSeq,
      captureAttempt: runScenarios.captureAttempts,
      proxyHoldMs: runs.proxyHoldMs,
    });
  return row ?? null;
}

/** The first delivery of an event type the store acknowledged for an order, byte for byte. */
export async function findAcknowledgedDelivery(
  orderId: string,
  eventType: string,
): Promise<{ eventId: string | null; headers: Record<string, string>; body: string; receivedAt: Date } | undefined> {
  const [row] = await getDb()
    .select({
      eventId: webhookDeliveries.eventId,
      headers: webhookDeliveries.headers,
      body: webhookDeliveries.body,
      receivedAt: webhookDeliveries.receivedAt,
    })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.orderId, orderId),
        eq(webhookDeliveries.eventType, eventType),
        gte(webhookDeliveries.responseStatus, 200),
        lt(webhookDeliveries.responseStatus, 300),
      ),
    )
    .orderBy(asc(webhookDeliveries.receivedAt))
    .limit(1);
  return row;
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
