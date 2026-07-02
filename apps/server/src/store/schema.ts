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
