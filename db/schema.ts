import { jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const webhookConfigs = pgTable("webhook_configs", {
  id: serial().primaryKey(),
  webhookEnabled: text("webhook_enabled").notNull().default("true"),
  webhookUrl: text("webhook_url").notNull().default(""),
  externalProjectUrl: text("external_project_url").notNull().default(""),
  webhookAuthType: text("webhook_auth_type").notNull().default("bearer"),
  webhookAuthToken: text("webhook_auth_token").notNull().default(""),
  webhookSecret: text("webhook_secret").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const webhookEvents = pgTable("webhook_events", {
  id: serial().primaryKey(),
  status: text("status").notNull(),
  message: text("message").notNull(),
  payload: jsonb("payload"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
});
