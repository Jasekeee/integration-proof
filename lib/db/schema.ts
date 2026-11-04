// Drizzle schema. Both reference stores share these tables; every order row records its mode.
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const STORE_MODES = ["naive", "hardened"] as const;
export type StoreMode = (typeof STORE_MODES)[number];

/** What the store believes about an order. Assertions compare it with PayPal, never trust it. */
export const ORDER_STATUSES = ["CREATED", "PENDING", "PAID", "DECLINED", "FAILED", "REFUNDED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const RUN_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "ERROR"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** WAITING_FOR_WEBHOOK: the scenario's actions are done and the store has not yet heard from PayPal. */
export const SCENARIO_STATUSES = ["QUEUED", "RUNNING", "WAITING_FOR_WEBHOOK", "COMPLETED", "ERROR"] as const;
export type ScenarioStatus = (typeof SCENARIO_STATUSES)[number];

/**
 * Decided by deterministic code, never by the model. INCONCLUSIVE: PayPal did not deliver a webhook
 * the scenario needs before the deadline, so neither PASS nor FAIL would be honest.
 */
export const VERDICTS = ["PASS", "FAIL", "INCONCLUSIVE"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** PENDING while Claude is working, READY with a validated analysis, UNAVAILABLE after one retry. */
export const ANALYSIS_STATUSES = ["PENDING", "READY", "UNAVAILABLE"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/** Result of checking a delivery's signature. NOT_CHECKED is what the naive store records. */
export const VERIFICATION_RESULTS = [
  "SUCCESS",
  "FAILURE",
  "MISSING_HEADERS",
  "UNAVAILABLE",
  "NOT_CHECKED",
] as const;
export type VerificationResult = (typeof VERIFICATION_RESULTS)[number];

export const storeMode = pgEnum("store_mode", STORE_MODES);
export const orderStatus = pgEnum("order_status", ORDER_STATUSES);
export const runStatus = pgEnum("run_status", RUN_STATUSES);
export const scenarioStatus = pgEnum("scenario_status", SCENARIO_STATUSES);
export const verdict = pgEnum("verdict", VERDICTS);
export const verificationResult = pgEnum("verification_result", VERIFICATION_RESULTS);
export const analysisStatus = pgEnum("analysis_status", ANALYSIS_STATUSES);

/** Run defaults: well above the store's observed PayPal latency, and well below its 15 s timeout. */
export const DEFAULT_STORE_TIMEOUT_MS = 8000;
export const DEFAULT_PROXY_HOLD_MS = 10_000;

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  mode: storeMode("mode").notNull(),
  status: runStatus("status").notNull().default("QUEUED"),
  scenarioIds: text("scenario_ids").array().notNull(),
  /** Timeout of every PayPal call the store makes during the run. Kept short so S3 is quick. */
  storeTimeoutMs: integer("store_timeout_ms").notNull().default(DEFAULT_STORE_TIMEOUT_MS),
  /** How long the proxy holds PayPal's answer in S3. Longer than the store timeout. */
  proxyHoldMs: integer("proxy_hold_ms").notNull().default(DEFAULT_PROXY_HOLD_MS),
  error: text("error"),
  createdAt: createdAt(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

/** One scenario of a run, with its own cart and its own key to the fault-injection proxy. */
export const runScenarios = pgTable(
  "run_scenarios",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id").notNull(),
    cartId: text("cart_id").notNull(),
    /**
     * Secret that only the runner and the store see. The store accepts a run's proxy only with it,
     * and the proxy URL carries it, so nobody outside the process can add requests to a scenario.
     * It never leaves the server: the runs API omits it and traces redact it.
     */
    runKey: text("run_key").notNull(),
    status: scenarioStatus("status").notNull().default("QUEUED"),
    verdict: verdict("verdict"),
    reason: text("reason"),
    error: text("error"),
    /** Last trace step number handed out. Steps take a number when they start, so nesting reads in order. */
    lastSeq: integer("last_seq").notNull().default(0),
    /** Capture requests the proxy has seen, so a fault can target the first attempt only. */
    captureAttempts: integer("capture_attempts").notNull().default(0),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** When the scenario started waiting for PayPal's webhooks, so the UI can count the seconds. */
    waitingSince: timestamp("waiting_since", { withTimezone: true }),
    /** The analysis of a FAIL or INCONCLUSIVE verdict. Several runs can share one cached analysis. */
    analysisKey: text("analysis_key").references(() => analyses.key, { onDelete: "set null" }),
    /** True when the analysis came from the cache and cost no tokens in this run. */
    analysisReused: boolean("analysis_reused"),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.scenarioId] }),
    uniqueIndex("run_scenarios_cart_id_key").on(table.cartId),
  ],
);

export const orders = pgTable(
  "orders",
  {
    /** Generated by the store before the PayPal call and sent as the purchase unit's custom_id. */
    id: uuid("id").primaryKey(),
    mode: storeMode("mode").notNull(),
    /** Harm is counted per cart: a buyer who checks out again creates a second order here. */
    cartId: text("cart_id").notNull(),
    runId: uuid("run_id").references(() => runs.id, { onDelete: "set null" }),
    paypalOrderId: text("paypal_order_id").notNull(),
    status: orderStatus("status").notNull().default("CREATED"),
    currencyCode: text("currency_code").notNull(),
    amountValue: text("amount_value").notNull(),
    captureId: text("capture_id"),
    /** The hardened store's stable PayPal-Request-Id for capture. Null in the naive store. */
    captureRequestId: text("capture_request_id"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("orders_paypal_order_id_key").on(table.paypalOrderId),
    index("orders_cart_id_idx").on(table.cartId),
    index("orders_run_id_idx").on(table.runId),
  ],
);

/** Every HTTP delivery the webhook router receives, kept byte for byte so it can be replayed. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    eventId: text("event_id"),
    eventType: text("event_type"),
    mode: storeMode("mode"),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "set null" }),
    /** PayPal transmission headers only. */
    headers: jsonb("headers").$type<Record<string, string>>().notNull(),
    body: text("body").notNull(),
    verification: verificationResult("verification").notNull(),
    outcome: text("outcome").notNull(),
    responseStatus: integer("response_status").notNull(),
  },
  (table) => [
    index("webhook_deliveries_event_id_idx").on(table.eventId),
    index("webhook_deliveries_order_id_idx").on(table.orderId),
  ],
);

/** Events the hardened store has applied. The primary key on event_id is the dedupe. */
export const webhookEvents = pgTable("webhook_events", {
  eventId: text("event_id").primaryKey(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One row per shipment. No unique constraint: the naive store must be able to ship twice. */
export const fulfilments = pgTable(
  "fulfilments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    eventId: text("event_id"),
    createdAt: createdAt(),
  },
  (table) => [index("fulfilments_order_id_idx").on(table.orderId)],
);

export const traceSteps = pgTable(
  "trace_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    scenarioId: text("scenario_id").notNull(),
    seq: integer("seq").notNull(),
    actor: text("actor").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    method: text("method"),
    path: text("path"),
    httpStatus: integer("http_status"),
    debugId: text("debug_id"),
    /** The PayPal-Request-Id the request carried, or null when it had none. */
    paypalRequestId: text("paypal_request_id"),
    fault: text("fault"),
    requestBody: jsonb("request_body"),
    responseBody: jsonb("response_body"),
    note: text("note"),
  },
  (table) => [uniqueIndex("trace_steps_run_scenario_seq_key").on(table.runId, table.scenarioId, table.seq)],
);

/**
 * Claude's explanation of a failed scenario. The key is the scenario, a hash of the store code and a
 * signature of the trace, so a run that fails the same way reuses the analysis and spends no tokens.
 */
export const analyses = pgTable("analyses", {
  key: text("key").primaryKey(),
  scenarioId: text("scenario_id").notNull(),
  mode: storeMode("mode").notNull(),
  model: text("model").notNull(),
  status: analysisStatus("status").notNull().default("PENDING"),
  /** The validated analysis. Evidence cites trace steps by their number in the scenario. */
  result: jsonb("result"),
  /** "applies", "needs_review" or "none", from applying the patch to the real file. */
  patchStatus: text("patch_status"),
  patchNote: text("patch_note"),
  error: text("error"),
  attempts: integer("attempts").notNull().default(0),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  durationMs: integer("duration_ms"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export type OrderRow = typeof orders.$inferSelect;
export type AnalysisRow = typeof analyses.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type RunScenarioRow = typeof runScenarios.$inferSelect;
export type TraceStepRow = typeof traceSteps.$inferSelect;
