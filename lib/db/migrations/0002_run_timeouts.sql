ALTER TABLE "runs" ADD COLUMN "store_timeout_ms" integer DEFAULT 8000 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "proxy_hold_ms" integer DEFAULT 10000 NOT NULL;