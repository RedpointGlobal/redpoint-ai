import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  config: text("config").notNull(), // JSON: provider, agent, mcp, skills, suggestions
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  title: text("title"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

/**
 * #27828 — per-conversation active RPI tenant (X-ClientID) selection.
 *
 * A light store, NOT a threads column: the web chat path keys conversations by
 * the AI SDK chat id (a non-UUID string that can't be the uuid `threads.id` in
 * Postgres), and the /chat path doesn't create thread rows. Keyed by
 * (conversationId, userId, workspaceId) — the userId scoping is the per-USER
 * isolation guard so a shared conversation id can't leak one user's active tenant
 * to another. NULL/absent row → fall back to RPI_DEFAULT_CLIENT_ID.
 *
 * Deliberately a CLEAN, separable context attribute — carries only the tenant
 * selection, never message/result data — so a future cross-chat data-carry or
 * cross-environment {url,token,clientId} routing can extend the same pattern
 * without untangling this from conversation content.
 */
export const conversationClients = sqliteTable("conversation_clients", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull(),
  userId: text("user_id").notNull(),
  workspaceId: text("workspace_id").notNull(),
  clientId: text("client_id").notNull(),
  clientName: text("client_name"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // user | assistant | system | tool
  content: text("content").notNull(),
  toolCalls: text("tool_calls"), // JSON
  toolResults: text("tool_results"), // JSON
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  threadId: text("thread_id")
    .notNull()
    .references(() => threads.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  promptTokens: integer("prompt_tokens"),
  completionTokens: integer("completion_tokens"),
  totalTokens: integer("total_tokens"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp" }),
});

export const apiKeys = sqliteTable("api_keys", {
  id: text("id").primaryKey(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: text("key_prefix").notNull(), // e.g., "rpai_abc..."
  name: text("name").notNull(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  permissions: text("permissions"), // JSON array of permissions
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id),
  threadId: text("thread_id").references(() => threads.id),
  runId: text("run_id").references(() => runs.id),
  action: text("action").notNull(), // tool_call | run_start | run_end | error
  details: text("details"), // JSON
  userId: text("user_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
