CREATE TYPE "public"."analysis_status" AS ENUM('PENDING', 'READY', 'UNAVAILABLE');--> statement-breakpoint
ALTER TYPE "public"."verdict" ADD VALUE 'INCONCLUSIVE';--> statement-breakpoint
CREATE TABLE "analyses" (
	"key" text PRIMARY KEY NOT NULL,
	"scenario_id" text NOT NULL,
	"mode" "store_mode" NOT NULL,
	"model" text NOT NULL,
	"status" "analysis_status" DEFAULT 'PENDING' NOT NULL,
	"result" jsonb,
	"patch_status" text,
	"patch_note" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "run_scenarios" ADD COLUMN "waiting_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "run_scenarios" ADD COLUMN "analysis_key" text;--> statement-breakpoint
ALTER TABLE "run_scenarios" ADD COLUMN "analysis_reused" boolean;--> statement-breakpoint
ALTER TABLE "run_scenarios" ADD CONSTRAINT "run_scenarios_analysis_key_analyses_key_fk" FOREIGN KEY ("analysis_key") REFERENCES "public"."analyses"("key") ON DELETE set null ON UPDATE no action;