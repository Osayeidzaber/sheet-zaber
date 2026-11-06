ALTER TABLE "api_configurations" ADD COLUMN "short_id" text;--> statement-breakpoint
UPDATE "api_configurations" SET "short_id" = (
  SELECT string_agg(substr('abcdefghijklmnopqrstuvwxyz0123456789', floor(random() * 36)::int + 1, 1), '')
  FROM generate_series(1, 5)
  WHERE "api_configurations"."id" IS NOT NULL
);--> statement-breakpoint
ALTER TABLE "api_configurations" ALTER COLUMN "short_id" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "api_configurations_short_id_idx" ON "api_configurations" USING btree ("short_id");
