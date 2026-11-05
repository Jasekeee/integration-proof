// The demo's limits: the visitor's address, the live-analysis token, runs per visitor and overall,
// and the daily ceiling on new analyses, the last three on an in-memory Postgres.
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reserveAnalysis } from "../ai/repository";
import * as schema from "../db/schema";
import { clientAddress, freshAllowed, visitorKey, waitFor } from "./limits";
import { createRun, markRunFinished, markRunStarted } from "./repository";

const CONFIG = { storeTimeoutMs: 8000, proxyHoldMs: 10_000, freshAnalysis: false };

describe("clientAddress", () => {
  it("takes Cloudflare's address over anything the client wrote into X-Forwarded-For", () => {
    const headers = new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4, 203.0.113.7, 172.70.1.1" });
    expect(clientAddress(headers)).toBe("203.0.113.7");
  });

  it("without Cloudflare, trusts only the rightmost X-Forwarded-For entry, which a client cannot write", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "6.6.6.6, 198.51.100.4" }))).toBe("198.51.100.4");
    expect(clientAddress(new Headers({ "x-forwarded-for": "198.51.100.4" }))).toBe("198.51.100.4");
  });

  it("falls back to one shared key when no address is known", () => {
    expect(clientAddress(new Headers())).toBe("unknown");
  });

  it("logs each source once, with the number of X-Forwarded-For entries and never the address", async () => {
    vi.resetModules();
    const { clientAddress: fresh } = await import("./limits");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    fresh(new Headers({ "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": "203.0.113.7, 172.70.1.1" }));
    fresh(new Headers({ "cf-connecting-ip": "198.51.100.4" }));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("Rate limits read the visitor's address from: cf-connecting-ip (x-forwarded-for entries: 2)");
    expect(JSON.stringify(log.mock.calls)).not.toContain("203.0.113.7");
    log.mockRestore();
  });
});

describe("visitorKey", () => {
  it("is stable, differs per address, and does not contain the address", () => {
    expect(visitorKey("203.0.113.7")).toBe(visitorKey("203.0.113.7"));
    expect(visitorKey("203.0.113.7")).not.toBe(visitorKey("203.0.113.8"));
    expect(visitorKey("203.0.113.7")).not.toContain("203.0.113.7");
  });
});

describe("freshAllowed", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never allows live analysis without a configured token", () => {
    vi.stubEnv("FRESH_ANALYSIS_TOKEN", "");
    expect(freshAllowed("1")).toBe(false);
    expect(freshAllowed("")).toBe(false);
  });

  it("allows it only for the exact token, whatever the length of a wrong one", () => {
    vi.stubEnv("FRESH_ANALYSIS_TOKEN", "s3cret-token-for-recording");
    expect(freshAllowed("s3cret-token-for-recording")).toBe(true);
    expect(freshAllowed("1")).toBe(false);
    expect(freshAllowed("s3cret-token-for-recordin")).toBe(false);
    expect(freshAllowed("s3cret-token-for-recording-and-more")).toBe(false);
    expect(freshAllowed(null)).toBe(false);
  });
});

describe("waitFor", () => {
  it("rounds up to whole minutes", () => {
    expect(waitFor(30)).toBe("less than a minute");
    expect(waitFor(61)).toBe("2 minutes");
    expect(waitFor(60)).toBe("1 minute");
  });
});

describe("limits in the database", () => {
  let database: PGlite;

  beforeEach(async () => {
    database = new PGlite();
    const instance = drizzle({ client: database, schema });
    await migrate(instance, { migrationsFolder: path.resolve("lib/db/migrations") });
    (globalThis as Record<string, unknown>).integrationProofDb = instance;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete (globalThis as Record<string, unknown>).integrationProofDb;
    await database.close();
  });

  /** Starts and finishes a run, so the next one is not blocked by "one run at a time". */
  async function finishedRun(visitor: string | null) {
    const created = await createRun("naive", ["S1"], CONFIG, visitor);
    if (created.kind !== "created") return created;
    await markRunStarted(created.run.id);
    await markRunFinished(created.run.id, null);
    return created;
  }

  it("stops a visitor after their hourly runs, with the time until the next, and lets another visitor run", async () => {
    vi.stubEnv("RUNS_PER_VISITOR_PER_HOUR", "2");
    const me = visitorKey("203.0.113.7");
    expect((await finishedRun(me)).kind).toBe("created");
    expect((await finishedRun(me)).kind).toBe("created");
    const third = await finishedRun(me);
    expect(third).toMatchObject({ kind: "rate_limited", scope: "visitor", limit: 2 });
    if (third.kind === "rate_limited") expect(third.retryAfterSeconds).toBeGreaterThan(3500);
    expect((await finishedRun(visitorKey("198.51.100.4"))).kind).toBe("created");
  });

  it("stops everyone once all visitors together reach the overall limit", async () => {
    vi.stubEnv("RUNS_PER_HOUR", "3");
    for (const address of ["a", "b", "c"]) expect((await finishedRun(visitorKey(address))).kind).toBe("created");
    expect(await finishedRun(visitorKey("d"))).toMatchObject({ kind: "rate_limited", scope: "everyone", limit: 3 });
  });

  it("counts new analyses against the daily ceiling, and never the one being checked or an unused claim", async () => {
    const db = (globalThis as unknown as { integrationProofDb: ReturnType<typeof drizzle<typeof schema>> }).integrationProofDb;
    const row = (key: string, values: Partial<typeof schema.analyses.$inferInsert>) => ({
      key,
      scenarioId: "S2",
      mode: "naive" as const,
      model: "m",
      ...values,
    });
    await db.insert(schema.analyses).values([
      row("called-1", { status: "READY", attempts: 1 }),
      row("in-flight", { status: "PENDING", attempts: 0 }),
      row("limited", { status: "UNAVAILABLE", attempts: 0 }),
      row("yesterday", { status: "READY", attempts: 1, startedAt: new Date(Date.now() - 25 * 60 * 60_000) }),
      row("mine", { status: "PENDING", attempts: 0 }),
    ]);
    expect(await reserveAnalysis("mine", 3)).toBe(true);
    expect(await reserveAnalysis("mine", 2)).toBe(false);
  });
});
