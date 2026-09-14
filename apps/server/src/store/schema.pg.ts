import { pgTable, text, uuid, timestamp, jsonb, integer } from "drizzle-orm/pg-core";

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const threads = pgTable("threads", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

/**
 * #27828 — per-conversation active RPI tenant (X-ClientID). Light store keyed by
 * (conversationId, userId, workspaceId); conversationId is the AI SDK chat id (a
 * non-UUID string), so it is text, not the uuid thread id. userId = per-USER
 * isolation. Mirrors the SQLite `conversationClients` table.
 */
export const conversationClients = pgTable("conversation_clients", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  userId: text("user_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  clientId: text("client_id").notNull(),
  clientName: text("client_name"),
  updatedAt: timestamp("updated_at").notNull(),
});

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id")
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  toolCalls: jsonb("tool_calls"),
  toolResults: jsonb("tool_results"),
  createdAt: timestamp("created_at").notNull(),
});

export const runs = pgTable("runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  threadId: uuid("thread_id")
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  createdAt: timestamp("created_at").notNull(),
  finishedAt: timestamp("finished_at"),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(),
  name: text("name").notNull(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  permissions: jsonb("permissions"),
  createdAt: timestamp("created_at").notNull(),
  expiresAt: timestamp("expires_at"),
  lastUsedAt: timestamp("last_used_at"),
});

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  threadId: uuid("thread_id").references(() => threads.id),
  runId: uuid("run_id").references(() => runs.id),
  action: text("action").notNull(),
  details: jsonb("details"),
  userId: text("user_id"),
  createdAt: timestamp("created_at").notNull(),
});
