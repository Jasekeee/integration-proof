// Runs a proof on the offline bench: the real runner, routes, proxy, stores and assertions of one
// checkout, against the in-memory PayPal model and an in-memory Postgres (PGlite) migrated with the
// real migrations. Only the network and the database server are replaced.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { installNetwork } from "./network";
import { PayPalModel } from "./paypal-model";

export const REPO_ROOT = path.resolve(__dirname, "..");

const WEBHOOK_ID = "WH-BENCH";

/** Configuration the code under test reads. Placeholders only: the bench holds no secret. */
const BENCH_ENV: Record<string, string | undefined> = {
  PAYPAL_CLIENT_ID: "bench-client",
  PAYPAL_CLIENT_SECRET: "bench-secret",
  PAYPAL_API_BASE: "https://api-m.sandbox.paypal.com",
  PAYPAL_WEBHOOK_ID: WEBHOOK_ID,
  PORT: "3000",
  // No model and no key: the runner records "no analysis" and never calls Claude.
  ANTHROPIC_MODEL: undefined,
  ANTHROPIC_API_KEY: undefined,
  DATABASE_URL: undefined,
};

/**
 * Short enough to keep a run quick, with the proxy's hold longer than the store's timeout as S3
 * requires. The ratio follows the deployed defaults of 8 s and 10 s.
 */
const STORE_TIMEOUT_MS = 800;
const PROXY_HOLD_MS = 1000;

export interface BenchScenario {
  id: string;
  status: string;
  verdict: "PASS" | "FAIL" | "INCONCLUSIVE" | null;
  headline: string | null;
  harm: string | null;
  reason: string | null;
  error: string | null;
}

export interface BenchRun {
  mode: "naive" | "hardened";
  scenarios: BenchScenario[];
  /** Calls the PayPal model does not cover. A run with any proves nothing. */
  violations: string[];
  /** Requests to anything but the app and the sandbox. Each was refused. */
  refused: string[];
}

const DB_GLOBAL = "integrationProofDb";

function load<T>(root: string, file: string): Promise<T> {
  return import(pathToFileURL(path.join(root, file)).href) as Promise<T>;
}

/** Runs the given scenarios against one store of the checkout at `root`, then returns the verdicts. */
export async function runOnBench(input: {
  mode: "naive" | "hardened";
  scenarioIds: string[];
  root?: string;
}): Promise<BenchRun> {
  const root = input.root ?? REPO_ROOT;
  const savedEnv = Object.fromEntries(Object.keys(BENCH_ENV).map((name) => [name, process.env[name]]));
  for (const [name, value] of Object.entries(BENCH_ENV)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }

  const database = new PGlite();
  const schema = await load<Record<string, unknown>>(root, "lib/db/schema.ts");
  const db = drizzle({ client: database, schema });
  await migrate(db, { migrationsFolder: path.join(root, "lib/db/migrations") });
  // getDb() returns this instance, so the code under test runs unchanged on the bench's database.
  (globalThis as Record<string, unknown>)[DB_GLOBAL] = db;

  const model = new PayPalModel(WEBHOOK_ID);
  const network = installNetwork(root, model);
  try {
    const repository = await load<typeof import("../lib/proof/repository")>(root, "lib/proof/repository.ts");
    const runner = await load<typeof import("../lib/proof/runner")>(root, "lib/proof/runner.ts");
    type ScenarioId = Parameters<typeof repository.createRun>[1][number];
    const created = await repository.createRun(input.mode, input.scenarioIds as ScenarioId[], {
      storeTimeoutMs: STORE_TIMEOUT_MS,
      proxyHoldMs: PROXY_HOLD_MS,
      freshAnalysis: false,
    });
    if (created.kind !== "created") throw new Error(`The bench could not create a run: ${created.kind}`);
    await runner.executeRun(created.run.id);

    const found = await repository.readRun(created.run.id);
    if (!found) throw new Error("The bench run disappeared");
    const scenarios = found.scenarios
      .map((row) => ({
        id: row.scenarioId,
        status: row.status,
        verdict: row.verdict,
        headline: row.headline,
        harm: row.harm,
        reason: row.reason,
        error: row.error,
      }))
      .sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
    return { mode: input.mode, scenarios, violations: [...model.violations], refused: [...network.refused] };
  } finally {
    network.restore();
    delete (globalThis as Record<string, unknown>)[DB_GLOBAL];
    await database.close();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
