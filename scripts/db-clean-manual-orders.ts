/**
 * Deletes abandoned manual checkouts: orders from /store/[mode] whose cart starts with "manual-",
 * that are still CREATED (the buyer never approved them) and older than an hour. Orders of proof
 * runs are never touched: they have a run id and carts named "cart-...".
 *
 *   npm run db:clean-manual            lists what would be deleted
 *   npm run db:clean-manual -- --yes   deletes it
 *
 * The database comes from DATABASE_URL in .env.local. Deliveries recorded for a deleted order keep
 * their row with no order, as the schema's foreign key says.
 */
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";

const MIN_AGE_MS = 60 * 60_000;

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { yes: { type: "boolean", default: false } } });
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const { and, eq, isNull, like, lt } = await import("drizzle-orm");
  const { getDb } = await import("../lib/db/client");
  const { orders } = await import("../lib/db/schema");

  const abandoned = and(
    like(orders.cartId, "manual-%"),
    eq(orders.status, "CREATED"),
    isNull(orders.runId),
    lt(orders.createdAt, new Date(Date.now() - MIN_AGE_MS)),
  );
  const db = getDb();
  const rows = await db
    .select({ id: orders.id, mode: orders.mode, createdAt: orders.createdAt })
    .from(orders)
    .where(abandoned);
  console.log(`${rows.length} abandoned manual order(s) older than an hour.`);
  for (const row of rows.slice(0, 20)) console.log(`  ${row.mode} ${row.id} ${row.createdAt.toISOString()}`);

  if (!values.yes) {
    if (rows.length > 0) console.log("Nothing deleted. Run again with --yes to delete them.");
  } else if (rows.length > 0) {
    const deleted = await db.delete(orders).where(abandoned).returning({ id: orders.id });
    console.log(`Deleted ${deleted.length} order(s).`);
  }
  await db.$client.end();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
