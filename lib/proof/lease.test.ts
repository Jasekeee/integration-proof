// Runs that lose their process: the lease rule, recovery, the one-run-at-a-time lease, the guards
// against a late process, the heartbeat and the SIGTERM path, on an in-memory Postgres with the real
// migrations.
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitLabel } from "../../app/_components/report";
import * as schema from "../db/schema";
import { INTERRUPTED_HEADLINE, INTERRUPTED_REASON, LEASE_MS, leaseState, OVERDUE_REASON, RUN_LIMIT_MS } from "./lease";
import { interruptActiveRuns } from "./lifecycle";
import {
  createRun,
  markRunFinished,
  markRunStarted,
  recoverInterruptedRuns,
  renewLease,
  updateScenario,
} from "./repository";
import { activeRuns, startHeartbeat } from "./runner";

const { runs, runScenarios } = schema;
const CONFIG = { storeTimeoutMs: 8000, proxyHoldMs: 10_000, freshAnalysis: false };
const ago = (ms: number) => new Date(Date.now() - ms);

describe("leaseState", () => {
  const base = { createdAt: ago(60_000), startedAt: ago(60_000) };

  it("calls a run live while its heartbeat is recent, and interrupted once it lapses", () => {
    expect(leaseState({ ...base, status: "RUNNING", lastHeartbeatAt: ago(5_000) })).toBe("live");
    expect(leaseState({ ...base, status: "RUNNING", lastHeartbeatAt: ago(LEASE_MS + 1) })).toBe("interrupted");
  });

  it("judges a run recorded before heartbeats by its start, and a queued one by its creation", () => {
    expect(leaseState({ status: "RUNNING", createdAt: ago(30 * 60_000), startedAt: ago(30 * 60_000), lastHeartbeatAt: null })).toBe("interrupted");
    expect(leaseState({ status: "RUNNING", createdAt: ago(60_000), startedAt: ago(60_000), lastHeartbeatAt: null })).toBe("interrupted");
    expect(leaseState({ status: "QUEUED", createdAt: ago(1_000), startedAt: null, lastHeartbeatAt: null })).toBe("live");
  });

  it("ends a run past its limit even while its heartbeat goes on, and leaves finished runs alone", () => {
    expect(leaseState({ status: "RUNNING", createdAt: ago(RUN_LIMIT_MS + 1), startedAt: ago(RUN_LIMIT_MS + 1), lastHeartbeatAt: ago(1_000) })).toBe("overdue");
    expect(leaseState({ ...base, status: "COMPLETED", lastHeartbeatAt: null })).toBe("finished");
  });
});

describe("waitLabel", () => {
  it("counts up to the limit and never past it", () => {
    expect(waitLabel(42_400, 150_000)).toBe("Waiting for PayPal webhook · 42 s of 150 s");
    expect(waitLabel(149_999, 150_000)).toBe("Waiting for PayPal webhook · 149 s of 150 s");
    // The run on the deployed service showed "1788 s of 150 s".
    expect(waitLabel(1_788_000, 150_000)).toBe("PayPal did not deliver within 150 s · recording the result");
  });
});

describe("runs that lose their process", () => {
  let database: PGlite;
  const db = () => (globalThis as unknown as { integrationProofDb: ReturnType<typeof drizzle<typeof schema>> }).integrationProofDb;

  beforeEach(async () => {
    database = new PGlite();
    const instance = drizzle({ client: database, schema });
    await migrate(instance, { migrationsFolder: path.resolve("lib/db/migrations") });
    (globalThis as Record<string, unknown>).integrationProofDb = instance;
  });

  afterEach(async () => {
    delete (globalThis as Record<string, unknown>).integrationProofDb;
    activeRuns().clear();
    await database.close();
  });

  /** A started naive run of S1 and S5, with S1 finished, as a run looks while S5 waits for PayPal. */
  async function runningRun(heartbeat: Date | null, startedAt = new Date()) {
    const created = await createRun("naive", ["S1", "S5"], CONFIG);
    if (created.kind !== "created") throw new Error(created.kind);
    await markRunStarted(created.run.id);
    await updateScenario(created.run.id, "S1", { status: "COMPLETED", verdict: "PASS", reason: "ok", headline: "Decline shown" });
    await updateScenario(created.run.id, "S5", { status: "WAITING_FOR_WEBHOOK", waitingSince: startedAt });
    await db().update(runs).set({ startedAt, lastHeartbeatAt: heartbeat }).where(eq(runs.id, created.run.id));
    return created.run.id;
  }

  async function scenarios(runId: string) {
    const rows = await db().select().from(runScenarios).where(eq(runScenarios.runId, runId));
    return Object.fromEntries(rows.map((row) => [row.scenarioId, row]));
  }

  it("ends a run whose heartbeat lapsed: unfinished scenarios INCONCLUSIVE with the reason, finished ones as they were", async () => {
    const runId = await runningRun(ago(LEASE_MS + 5_000), ago(2 * 60_000));
    expect(await recoverInterruptedRuns()).toEqual([runId]);

    const [run] = await db().select().from(runs).where(eq(runs.id, runId));
    expect(run).toMatchObject({ status: "COMPLETED", error: INTERRUPTED_REASON });
    const { S1, S5 } = await scenarios(runId);
    expect(S1).toMatchObject({ status: "COMPLETED", verdict: "PASS" });
    expect(S5).toMatchObject({
      status: "COMPLETED",
      verdict: "INCONCLUSIVE",
      reason: "Run interrupted: the server restarted while waiting for PayPal. Run again.",
      headline: INTERRUPTED_HEADLINE,
      waitingSince: null,
    });
  });

  it("ends a run recorded before heartbeats existed, like the one a deploy left running", async () => {
    const runId = await runningRun(null, ago(30 * 60_000));
    expect(await recoverInterruptedRuns()).toEqual([runId]);
    const [run] = await db().select().from(runs).where(eq(runs.id, runId));
    expect(run.error).toBe(INTERRUPTED_REASON);
    expect((await scenarios(runId)).S5.verdict).toBe("INCONCLUSIVE");
  });

  it("stops a run that is still beating but has run past its limit", async () => {
    const runId = await runningRun(new Date(), ago(RUN_LIMIT_MS + 60_000));
    expect(await recoverInterruptedRuns()).toEqual([runId]);
    const [run] = await db().select().from(runs).where(eq(runs.id, runId));
    expect(run.error).toBe(OVERDUE_REASON);
  });

  it("leaves a run with a live heartbeat alone", async () => {
    const runId = await runningRun(new Date());
    expect(await recoverInterruptedRuns()).toEqual([]);
    const [run] = await db().select().from(runs).where(eq(runs.id, runId));
    expect(run.status).toBe("RUNNING");
  });

  it("lets a new run start past an orphaned one, which it ends, but not past a live one", async () => {
    const orphan = await runningRun(ago(LEASE_MS + 1_000));
    const next = await createRun("hardened", ["S1"], CONFIG);
    expect(next.kind).toBe("created");
    const [ended] = await db().select().from(runs).where(eq(runs.id, orphan));
    expect(ended.status).toBe("COMPLETED");

    if (next.kind !== "created") return;
    await markRunStarted(next.run.id);
    expect(await createRun("naive", ["S1"], CONFIG)).toEqual({ kind: "busy", runId: next.run.id });
  });

  it("keeps a late process from overwriting a run that recovery ended", async () => {
    const runId = await runningRun(ago(LEASE_MS + 1_000));
    await recoverInterruptedRuns();

    expect(await renewLease(runId)).toBe(false);
    await updateScenario(runId, "S5", { status: "COMPLETED", verdict: "FAIL", reason: "late" });
    await markRunFinished(runId, null);
    expect((await scenarios(runId)).S5).toMatchObject({ verdict: "INCONCLUSIVE", reason: INTERRUPTED_REASON });
    const [run] = await db().select().from(runs).where(eq(runs.id, runId));
    expect(run.error).toBe(INTERRUPTED_REASON);
  });

  it("renews the lease on every heartbeat while the run is running", async () => {
    const runId = await runningRun(ago(LEASE_MS - 1_000));
    const stop = startHeartbeat(runId, 20);
    await new Promise((resolve) => setTimeout(resolve, 120));
    stop();
    const [run] = await db().select().from(runs).where(eq(runs.id, runId));
    expect(Date.now() - run.lastHeartbeatAt!.getTime()).toBeLessThan(1_000);
    expect(await recoverInterruptedRuns()).toEqual([]);
  });

  it("ends this process's runs on shutdown, as SIGTERM does, and only those", async () => {
    const mine = await runningRun(new Date());
    activeRuns().add(mine);
    expect(await interruptActiveRuns()).toEqual([mine]);
    expect((await scenarios(mine)).S5).toMatchObject({ verdict: "INCONCLUSIVE", reason: INTERRUPTED_REASON });
    expect(activeRuns().size).toBe(0);
    expect(await interruptActiveRuns()).toEqual([]);
  });
});
