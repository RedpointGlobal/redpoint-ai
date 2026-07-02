import { z } from "zod";

export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);

export const MessageSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  role: MessageRoleSchema,
  content: z.string(),
  toolCalls: z.any().optional(),
  toolResults: z.any().optional(),
  createdAt: z.coerce.date(),
});

export const ThreadSchema = z.object({
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  title: z.string().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const RunSchema = z.object({
  id: z.string().uuid(),
  threadId: z.string().uuid(),
  status: RunStatusSchema,
  error: z.string().optional(),
  tokenUsage: z
    .object({
      promptTokens: z.number(),
      completionTokens: z.number(),
      totalTokens: z.number(),
    })
    .optional(),
  createdAt: z.coerce.date(),
  finishedAt: z.coerce.date().optional(),
});

export type Message = z.infer<typeof MessageSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type Run = z.infer<typeof RunSchema>;
export type RunStatus = z.infer<typeof RunStatusSchema>;
