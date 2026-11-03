CREATE TYPE "public"."order_status" AS ENUM('CREATED', 'PENDING', 'PAID', 'DECLINED', 'FAILED', 'REFUNDED');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('QUEUED', 'RUNNING', 'COMPLETED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."store_mode" AS ENUM('naive', 'hardened');--> statement-breakpoint
CREATE TYPE "public"."verification_result" AS ENUM('SUCCESS', 'FAILURE', 'MISSING_HEADERS', 'UNAVAILABLE', 'NOT_CHECKED');--> statement-breakpoint
CREATE TABLE "fulfilments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"mode" "store_mode" NOT NULL,
	"cart_id" text NOT NULL,
	"run_id" uuid,
	"paypal_order_id" text NOT NULL,
	"status" "order_status" DEFAULT 'CREATED' NOT NULL,
	"currency_code" text NOT NULL,
	"amount_value" text NOT NULL,
	"capture_id" text,
	"capture_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mode" "store_mode" NOT NULL,
	"status" "run_status" DEFAULT 'QUEUED' NOT NULL,
	"scenario_ids" text[] NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "trace_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"scenario_id" text NOT NULL,
	"seq" integer NOT NULL,
	"actor" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer NOT NULL,
	"method" text,
	"path" text,
	"http_status" integer,
	"debug_id" text,
	"fault" text,
	"request_body" jsonb,
	"response_body" jsonb,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_id" text,
	"event_type" text,
	"mode" "store_mode",
	"order_id" uuid,
	"headers" jsonb NOT NULL,
	"body" text NOT NULL,
	"verification" "verification_result" NOT NULL,
	"outcome" text NOT NULL,
	"response_status" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fulfilments" ADD CONSTRAINT "fulfilments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trace_steps" ADD CONSTRAINT "trace_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_events" ADD CONSTRAINT "webhook_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fulfilments_order_id_idx" ON "fulfilments" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_paypal_order_id_key" ON "orders" USING btree ("paypal_order_id");--> statement-breakpoint
CREATE INDEX "orders_cart_id_idx" ON "orders" USING btree ("cart_id");--> statement-breakpoint
CREATE INDEX "orders_run_id_idx" ON "orders" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "trace_steps_run_scenario_seq_key" ON "trace_steps" USING btree ("run_id","scenario_id","seq");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_event_id_idx" ON "webhook_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_order_id_idx" ON "webhook_deliveries" USING btree ("order_id");