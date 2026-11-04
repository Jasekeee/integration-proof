// Database reads and writes for analyses: the cache, and the link from a scenario of a run.
import { and, eq, inArray, lt, or } from "drizzle-orm";
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
