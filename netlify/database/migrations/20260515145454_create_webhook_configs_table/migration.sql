CREATE TABLE "webhook_configs" (
	"id" serial PRIMARY KEY,
	"webhook_enabled" text DEFAULT 'true' NOT NULL,
	"webhook_url" text DEFAULT '' NOT NULL,
	"external_project_url" text DEFAULT '' NOT NULL,
	"webhook_auth_type" text DEFAULT 'bearer' NOT NULL,
	"webhook_auth_token" text DEFAULT '' NOT NULL,
	"webhook_secret" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" serial PRIMARY KEY,
	"status" text NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
