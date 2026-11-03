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

  const db = drizzle({ client: new Pool({ connectionString, max: 5 }), schema });
  globalForDb.integrationProofDb = db;
  return db;
}
