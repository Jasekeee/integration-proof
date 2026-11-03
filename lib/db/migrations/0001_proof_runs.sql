CREATE TYPE "public"."scenario_status" AS ENUM('QUEUED', 'RUNNING', 'WAITING_FOR_WEBHOOK', 'COMPLETED', 'ERROR');--> statement-breakpoint
CREATE TYPE "public"."verdict" AS ENUM('PASS', 'FAIL');--> statement-breakpoint
CREATE TABLE "run_scenarios" (
	"run_id" uuid NOT NULL,
	"scenario_id" text NOT NULL,
	"cart_id" text NOT NULL,
	"run_key" text NOT NULL,
	"status" "scenario_status" DEFAULT 'QUEUED' NOT NULL,
	"verdict" "verdict",
	"reason" text,
	"error" text,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"capture_attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "run_scenarios_run_id_scenario_id_pk" PRIMARY KEY("run_id","scenario_id")
);
--> statement-breakpoint
ALTER TABLE "trace_steps" ADD COLUMN "paypal_request_id" text;--> statement-breakpoint
ALTER TABLE "run_scenarios" ADD CONSTRAINT "run_scenarios_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_scenarios_cart_id_key" ON "run_scenarios" USING btree ("cart_id");