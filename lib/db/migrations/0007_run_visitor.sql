ALTER TABLE "runs" ADD COLUMN "visitor" text;--> statement-breakpoint
CREATE INDEX "runs_visitor_created_at_idx" ON "runs" USING btree ("visitor","created_at");