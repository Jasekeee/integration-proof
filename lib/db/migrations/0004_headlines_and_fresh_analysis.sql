ALTER TABLE "run_scenarios" ADD COLUMN "headline" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "fresh_analysis" boolean DEFAULT false NOT NULL;