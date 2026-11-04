// Database client: one node-postgres pool per process, reused across hot reloads in development.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

export type Database = NodePgDatabase<typeof schema> & { $client: Pool };

const globalForDb = globalThis as typeof globalThis & { integrationProofDb?: Database };

export function getDb(): Database {
  if (globalForDb.integrationProofDb) return globalForDb.integrationProofDb;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");

  const pool = new Pool({
    connectionString,
    // A full proof runs six scenarios at once, and every proxied PayPal call claims and writes a
    // trace step. Enough connections keep that bookkeeping out of the store's PayPal timeout.
    max: 15,
    idleTimeoutMillis: 30_000,
    // A connection that died without a word must fail fast instead of hanging a run for minutes.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    query_timeout: 20_000,
  });
  // An idle connection that drops raises an error on the pool; without a listener it would crash
  // the process. The pool discards that connection and opens a new one when it is needed.
  pool.on("error", (error) => console.error("Database connection lost", error.message));

  const db = drizzle({ client: pool, schema });
  globalForDb.integrationProofDb = db;
  return db;
}
