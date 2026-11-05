// Database reads and writes for analyses: the cache, and the link from a scenario of a run.
import { and, count, eq, gt, inArray, lt, ne, or, sql } from "drizzle-orm";
import { getDb } from "../db/client";
import { analyses, runScenarios, type AnalysisRow, type StoreMode } from "../db/schema";
import { totalUsage, type AnalysisCache } from "./analyst";

/** A PENDING analysis older than this lost its process and may be started again. */
const STALE_AFTER_MS = 10 * 60_000;

export function databaseCache(meta: { scenarioId: string; mode: StoreMode; model: string }): AnalysisCache {
  return {
    async claim(key, options) {
      const db = getDb();
      const inserted = await db
        .insert(analyses)
        .values({ key, ...meta, status: "PENDING" })
        .onConflictDoNothing()
        .returning({ key: analyses.key });
      if (inserted.length > 0) return "claimed";

      // Failed and abandoned analyses are tried again; a READY one only when fresh is asked for.
      const stale = and(eq(analyses.status, "PENDING"), lt(analyses.startedAt, new Date(Date.now() - STALE_AFTER_MS)));
      const retryable = options?.fresh
        ? or(eq(analyses.status, "UNAVAILABLE"), eq(analyses.status, "READY"), stale)
        : or(eq(analyses.status, "UNAVAILABLE"), stale);
      const reclaimed = await db
        .update(analyses)
        .set({ status: "PENDING", startedAt: new Date(), completedAt: null, error: null })
        .where(and(eq(analyses.key, key), retryable))
        .returning({ key: analyses.key });
      if (reclaimed.length > 0) return "claimed";

      const [row] = await db.select({ status: analyses.status }).from(analyses).where(eq(analyses.key, key));
      return row?.status === "READY" ? "ready" : "in_progress";
    },

    async save(key, result) {
      const usage = totalUsage(result.calls);
      const durationMs = result.calls.reduce((sum, call) => sum + call.durationMs, 0);
      await getDb()
        .update(analyses)
        .set({
          status: result.status,
          result: result.status === "READY" ? result.analysis : null,
          patchStatus: result.status === "READY" ? result.patch.status : null,
          patchNote: result.status === "READY" ? result.patch.note : null,
          error: result.status === "UNAVAILABLE" ? result.reason : null,
          attempts: result.calls.length,
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          durationMs,
          completedAt: new Date(),
        })
        .where(eq(analyses.key, key));
    },
  };
}

export async function linkAnalysis(runId: string, scenarioId: string, key: string, reused: boolean): Promise<void> {
  await getDb()
    .update(runScenarios)
    .set({ analysisKey: key, analysisReused: reused })
    .where(and(eq(runScenarios.runId, runId), eq(runScenarios.scenarioId, scenarioId)));
}

export async function readAnalyses(keys: string[]): Promise<AnalysisRow[]> {
  if (keys.length === 0) return [];
  return getDb().select().from(analyses).where(inArray(analyses.key, keys));
}

/** Any constant works; it only has to be the same for every caller. */
const QUOTA_LOCK_KEY = 7_302_612;

/**
 * Whether a newly claimed analysis may call the model, under the ceiling of `limit` new analyses in
 * any 24 hours. Counts the analyses that called the model or are about to; served from the cache,
 * an analysis never reaches this. Serialised, so analyses claimed at the same moment cannot all
 * take the last place.
 */
export async function reserveAnalysis(key: string, limit: number, now = new Date()): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${QUOTA_LOCK_KEY})`);
    const since = new Date(now.getTime() - 24 * 60 * 60_000);
    const [row] = await tx
      .select({ total: count() })
      .from(analyses)
      .where(
        and(
          ne(analyses.key, key),
          gt(analyses.startedAt, since),
          or(gt(analyses.attempts, 0), eq(analyses.status, "PENDING")),
        ),
      );
    return row.total < limit;
  });
}
