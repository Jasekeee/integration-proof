// Database reads and writes for both stores. Behaviour lives in naive.ts and hardened.ts.
import { and, count, desc, eq, inArray, or, type SQL } from "drizzle-orm";
import { getDb } from "../db/client";
import {
  fulfilments,
  orders,
  webhookDeliveries,
  webhookEvents,
  type OrderRow,
  type OrderStatus,
  type StoreMode,
} from "../db/schema";
import type { PayPalResponse } from "../paypal/client";
import { PayPalOrderSchema } from "../paypal/orders";
import { PRODUCT, StoreError, type CaptureResult, type CreateOrderInput } from "./shared";

/** Stores the order PayPal just created, or throws when PayPal did not create one. */
export async function insertCreatedOrder(input: {
  id: string;
  mode: StoreMode;
  order: CreateOrderInput;
  response: PayPalResponse;
  captureRequestId: string | null;
}): Promise<OrderRow> {
  const { response } = input;
  if (response.kind === "no_response") {
    throw new StoreError(`PayPal did not answer the create order call (${response.reason})`, 504);
  }
  const created = PayPalOrderSchema.safeParse(response.body);
  if (response.status !== 201 || !created.success) {
    throw new StoreError(`PayPal did not create the order: HTTP ${response.status}`, 502, response.debugId);
  }

  const [row] = await getDb()
    .insert(orders)
    .values({
      id: input.id,
      mode: input.mode,
      cartId: input.order.cartId,
      runId: input.order.runId ?? null,
      paypalOrderId: created.data.id,
      status: "CREATED",
      currencyCode: PRODUCT.amount.currency_code,
      amountValue: PRODUCT.amount.value,
      captureRequestId: input.captureRequestId,
    })
    .returning();
  return row;
}

export async function saveCaptureResult(orderId: string, result: CaptureResult): Promise<void> {
  await getDb()
    .update(orders)
    .set(result.captureId ? { status: result.status, captureId: result.captureId } : { status: result.status })
    .where(eq(orders.id, orderId));
}

export async function setOrderStatus(orderId: string, status: OrderStatus): Promise<void> {
  await getDb().update(orders).set({ status }).where(eq(orders.id, orderId));
}

export async function recordFulfilment(orderId: string, eventId: string): Promise<void> {
  await getDb().insert(fulfilments).values({ orderId, eventId });
}

export async function isEventProcessed(eventId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ eventId: webhookEvents.eventId })
    .from(webhookEvents)
    .where(eq(webhookEvents.eventId, eventId));
  return row !== undefined;
}

/**
 * Claims the event id and applies its effect in one transaction. Returns false when another
 * delivery of the same event got there first; the primary key on event_id decides.
 */
export async function applyEventOnce(input: {
  orderId: string;
  eventId: string;
  eventType: string;
  result: CaptureResult | null;
  fulfil: boolean;
}): Promise<boolean> {
  return getDb().transaction(async (tx) => {
    const claimed = await tx
      .insert(webhookEvents)
      .values({ eventId: input.eventId, orderId: input.orderId, eventType: input.eventType })
      .onConflictDoNothing()
      .returning({ eventId: webhookEvents.eventId });
    if (claimed.length === 0) return false;

    if (input.result) {
      const { status, captureId } = input.result;
      await tx
        .update(orders)
        .set(captureId ? { status, captureId } : { status })
        .where(eq(orders.id, input.orderId));
    }
    if (input.fulfil) {
      await tx.insert(fulfilments).values({ orderId: input.orderId, eventId: input.eventId });
    }
    return true;
  });
}

export async function findOrder(mode: StoreMode, paypalOrderId: string): Promise<OrderRow | undefined> {
  const [row] = await getDb()
    .select()
    .from(orders)
    .where(and(eq(orders.mode, mode), eq(orders.paypalOrderId, paypalOrderId)));
  return row;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Finds the order an event is about, by PayPal order id or by the store's own id in custom_id. */
export async function findOrderForEvent(reference: {
  paypalOrderId?: string;
  customId?: string;
}): Promise<OrderRow | undefined> {
  const conditions: SQL[] = [];
  if (reference.paypalOrderId) conditions.push(eq(orders.paypalOrderId, reference.paypalOrderId));
  if (reference.customId && UUID_PATTERN.test(reference.customId)) {
    conditions.push(eq(orders.id, reference.customId));
  }
  if (conditions.length === 0) return undefined;
  const [row] = await getDb()
    .select()
    .from(orders)
    .where(or(...conditions))
    .limit(1);
  return row;
}

export async function recordDelivery(values: typeof webhookDeliveries.$inferInsert): Promise<void> {
  await getDb().insert(webhookDeliveries).values(values);
}

const STATE_LIMIT = 50;

/** The read-only state contract the runner asserts against. */
export async function readState(mode: StoreMode, filter: { cartId?: string; runId?: string }) {
  const db = getDb();
  const conditions: SQL[] = [eq(orders.mode, mode)];
  if (filter.cartId) conditions.push(eq(orders.cartId, filter.cartId));
  if (filter.runId) conditions.push(eq(orders.runId, filter.runId));

  const rows = await db
    .select()
    .from(orders)
    .where(and(...conditions))
    .orderBy(desc(orders.createdAt))
    .limit(STATE_LIMIT);
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return { orders: [], deliveries: [] };

  const fulfilmentCounts = await db
    .select({ orderId: fulfilments.orderId, count: count() })
    .from(fulfilments)
    .where(inArray(fulfilments.orderId, ids))
    .groupBy(fulfilments.orderId);
  const deliveries = await db
    .select({
      receivedAt: webhookDeliveries.receivedAt,
      orderId: webhookDeliveries.orderId,
      eventId: webhookDeliveries.eventId,
      eventType: webhookDeliveries.eventType,
      verification: webhookDeliveries.verification,
      outcome: webhookDeliveries.outcome,
      responseStatus: webhookDeliveries.responseStatus,
    })
    .from(webhookDeliveries)
    .where(inArray(webhookDeliveries.orderId, ids))
    .orderBy(webhookDeliveries.receivedAt);

  const fulfilled = new Map(fulfilmentCounts.map((row) => [row.orderId, row.count]));
  return {
    orders: rows.map((row) => ({
      id: row.id,
      paypalOrderId: row.paypalOrderId,
      cartId: row.cartId,
      runId: row.runId,
      status: row.status,
      captureId: row.captureId,
      amount: { currency_code: row.currencyCode, value: row.amountValue },
      fulfilments: fulfilled.get(row.id) ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
    deliveries,
  };
}
