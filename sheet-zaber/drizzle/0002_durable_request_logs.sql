ALTER TABLE "api_request_logs" DROP CONSTRAINT "api_request_logs_api_id_api_configurations_id_fk";
--> statement-breakpoint
ALTER TABLE "api_request_logs" DROP CONSTRAINT "api_request_logs_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "api_request_logs" ADD COLUMN "api_name" text;--> statement-breakpoint
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_api_id_api_configurations_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."api_configurations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
UPDATE "api_request_logs" AS l SET "api_name" = a."name" FROM "api_configurations" AS a WHERE l."api_id" = a."id";
