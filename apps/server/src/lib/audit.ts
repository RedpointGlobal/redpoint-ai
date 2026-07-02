import { db } from "../store/db.js";
import { auditLogs } from "../store/schema.js";
import { randomUUID } from "crypto";

interface AuditParams {
  workspaceId?: string;
  threadId?: string;
  runId?: string;
  action: "run_start" | "run_end" | "tool_call" | "error" | "hallucination_detected";
  details?: Record<string, unknown>;
  userId?: string;
}

/**
 * Log an audit event. Fire-and-forget — audit failures
 * never break the main request flow.
 */
export async function logAudit(params: AuditParams): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: randomUUID(),
      workspaceId: params.workspaceId ?? null,
      threadId: params.threadId ?? null,
      runId: params.runId ?? null,
      action: params.action,
      details: params.details ? JSON.stringify(params.details) : null,
      userId: params.userId ?? null,
      createdAt: new Date(),
    });
  } catch {
    // Fire-and-forget: don't let audit failures break the main flow
  }
}
