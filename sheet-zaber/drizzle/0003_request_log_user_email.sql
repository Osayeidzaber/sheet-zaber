ALTER TABLE "api_request_logs" ADD COLUMN "user_email" text;
--> statement-breakpoint
UPDATE "api_request_logs" AS l SET "user_email" = u."email" FROM "users" AS u WHERE l."user_id" = u."id";
