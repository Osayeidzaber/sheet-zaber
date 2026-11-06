CREATE TABLE "api_configurations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"spreadsheet_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"tab_title" text NOT NULL,
	"header_row" integer DEFAULT 1 NOT NULL,
	"primary_key_column" text,
	"permissions" text DEFAULT 'read' NOT NULL,
	"allowed_operations" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_per_hour" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_configurations_header_row_check" CHECK (header_row >= 1),
	CONSTRAINT "api_configurations_permissions_check" CHECK (permissions in ('read', 'read_write'))
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_preview" text NOT NULL,
	"scopes" jsonb DEFAULT '["read"]'::jsonb NOT NULL,
	"allowed_api_ids" jsonb,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "api_request_logs" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "api_request_logs_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"api_id" text,
	"user_id" text,
	"api_key_id" text,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status_code" integer NOT NULL,
	"duration_ms" integer NOT NULL,
	"request_bytes" integer,
	"error_category" text,
	"origin" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "google_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"google_email" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"scope" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"last_used_at" timestamp with time zone,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_connections_user_email_unique" UNIQUE("user_id","google_email"),
	CONSTRAINT "google_connections_status_check" CHECK (status in ('connected', 'reauth_required', 'disconnected'))
);
--> statement-breakpoint
CREATE TABLE "invitation_redemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"invitation_id" text NOT NULL,
	"redeemed_by" text NOT NULL,
	"redeemed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_redemptions_invitation_user_unique" UNIQUE("invitation_id","redeemed_by")
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"label" text,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_code_hash_unique" UNIQUE("code_hash"),
	CONSTRAINT "invitations_max_uses_check" CHECK (max_uses >= 1),
	CONSTRAINT "invitations_uses_check" CHECK (uses >= 0 and uses <= max_uses)
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"bucket_key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "registered_spreadsheets" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"google_sheet_id" text NOT NULL,
	"title" text NOT NULL,
	"tabs" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registered_spreadsheets_user_sheet_unique" UNIQUE("user_id","google_sheet_id"),
	CONSTRAINT "registered_spreadsheets_status_check" CHECK (status in ('active', 'inaccessible'))
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"picture_url" text,
	"timezone" text,
	"theme" text DEFAULT 'dark' NOT NULL,
	"dashboard_prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "user_profiles_theme_check" CHECK (theme in ('dark', 'light', 'system'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"google_sub" text NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"invitation_id" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_google_sub_unique" UNIQUE("google_sub"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_role_check" CHECK (role in ('user', 'owner')),
	CONSTRAINT "users_status_check" CHECK (status in ('active', 'disabled'))
);
--> statement-breakpoint
ALTER TABLE "api_configurations" ADD CONSTRAINT "api_configurations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_configurations" ADD CONSTRAINT "api_configurations_spreadsheet_id_registered_spreadsheets_id_fk" FOREIGN KEY ("spreadsheet_id") REFERENCES "public"."registered_spreadsheets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_api_id_api_configurations_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."api_configurations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_request_logs" ADD CONSTRAINT "api_request_logs_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_connections" ADD CONSTRAINT "google_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_redemptions" ADD CONSTRAINT "invitation_redemptions_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation_redemptions" ADD CONSTRAINT "invitation_redemptions_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registered_spreadsheets" ADD CONSTRAINT "registered_spreadsheets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registered_spreadsheets" ADD CONSTRAINT "registered_spreadsheets_connection_id_google_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."google_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_invitation_id_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_configurations_user_id_idx" ON "api_configurations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_configurations_enabled_idx" ON "api_configurations" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "api_keys_user_id_idx" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "api_keys_key_hash_active_idx" ON "api_keys" USING btree ("key_hash") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "api_request_logs_api_created_idx" ON "api_request_logs" USING btree ("api_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "api_request_logs_user_created_idx" ON "api_request_logs" USING btree ("user_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "api_request_logs_created_at_idx" ON "api_request_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_created_idx" ON "audit_logs" USING btree ("actor_id","created_at" desc);--> statement-breakpoint
CREATE INDEX "audit_logs_subject_idx" ON "audit_logs" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "google_connections_status_idx" ON "google_connections" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invitations_code_hash_active_idx" ON "invitations" USING btree ("code_hash") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "registered_spreadsheets_user_id_idx" ON "registered_spreadsheets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_not_deleted_idx" ON "users" USING btree ("email") WHERE status <> 'deleted';--> statement-breakpoint
-- RLS deny-by-default (database-schema.md): enabled on every table, NO policies.
-- The app role owns the tables (bypasses RLS); any leaked anon/authenticated key reads nothing.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invitation_redemptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "google_connections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "registered_spreadsheets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_configurations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_request_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ENABLE ROW LEVEL SECURITY;
