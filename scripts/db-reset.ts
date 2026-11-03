/**
 * Deletes every row the app has written: runs, trace steps, orders, webhook deliveries and events,
 * fulfilments. The schema and the migration history stay, so nothing has to be migrated afterwards.
 *
 *   npm run db:reset            prints the row count of each table and deletes nothing
 *   npm run db:reset -- --yes   empties those tables
 *
 * DATABASE_URL comes from .env.local when the file exists, otherwise from the environment. The
 * script prints the host and database it works on, never the credentials.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { getDb } from "../lib/db/client";
import * as schema from "../lib/db/schema";

/** Every table in the schema, so a table added later is reset as well. */
const TABLES = Object.values<unknown>(schema).filter((value): value is PgTable => is(value, PgTable));

async function main(): Promise<void> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const { values } = parseArgs({ options: { yes: { type: "boolean", default: false } } });

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const target = new URL(connectionString);
  console.log(`Database ${target.hostname}${target.pathname}`);

  const db = getDb();
  try {
    let total = 0;
    for (const table of TABLES) {
      const rows = await db.$count(table);
      total += rows;
      console.log(`  ${getTableName(table).padEnd(20)} ${rows}`);
    }

    if (!values.yes) {
      console.log(`${total} rows. Nothing deleted; run again with --yes to empty these tables.`);
      return;
    }

    // One statement, so the tables empty together and foreign keys between them do not get in the
    // way. No CASCADE: a table outside this list that references them makes the reset fail instead.
    await db.execute(sql`TRUNCATE TABLE ${sql.join(TABLES, sql`, `)}`);
    console.log(`Deleted ${total} rows from ${TABLES.length} tables.`);
  } finally {
    await db.$client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
