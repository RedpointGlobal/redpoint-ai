import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../store/db.js";
import { threads, messages, runs } from "../store/schema.js";
import { eq, desc } from "drizzle-orm";
import { randomUUID } from "crypto";

const CreateThreadSchema = z.object({
  title: z.string().optional(),
});

const CreateRunSchema = z.object({
  message: z.string().min(1),
});

export const threadRoutes = new Hono();

// GET /threads - List threads for a workspace
threadRoutes.get("/", async (c) => {
  const workspaceId = c.req.param("workspaceId")!;
  const result = await db
    .select()
    .from(threads)
    .where(eq(threads.workspaceId, workspaceId))
    .orderBy(desc(threads.updatedAt));
  return c.json(result);
});

// POST /threads - Create a new thread
threadRoutes.post("/", zValidator("json", CreateThreadSchema), async (c) => {
  const workspaceId = c.req.param("workspaceId");
  const body = c.req.valid("json");
  const now = new Date();
  const thread = {
    id: randomUUID(),
    workspaceId,
    title: body.title ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(threads).values(thread);
  return c.json(thread, 201);
});

// GET /threads/:threadId - Get thread with messages
threadRoutes.get("/:threadId", async (c) => {
  const threadId = c.req.param("threadId");
  const [thread] = await db
    .select()
    .from(threads)
    .where(eq(threads.id, threadId));
  if (!thread) return c.json({ error: "Thread not found" }, 404);

  const threadMessages = await db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(messages.createdAt);

  return c.json({ ...thread, messages: threadMessages });
});

// DELETE /threads/:threadId - Delete thread (cascades messages and runs)
threadRoutes.delete("/:threadId", async (c) => {
  const threadId = c.req.param("threadId");
  const [existing] = await db
    .select()
    .from(threads)
    .where(eq(threads.id, threadId));
  if (!existing) return c.json({ error: "Thread not found" }, 404);
  await db.delete(threads).where(eq(threads.id, threadId));
  return c.json({ deleted: true });
});

// POST /threads/:threadId/runs - Create a run
threadRoutes.post(
  "/:threadId/runs",
  zValidator("json", CreateRunSchema),
  async (c) => {
    const threadId = c.req.param("threadId");
    const body = c.req.valid("json");
    const now = new Date();

    // Save user message
    const userMsg = {
      id: randomUUID(),
      threadId,
      role: "user" as const,
      content: body.message,
      toolCalls: null,
      toolResults: null,
      createdAt: now,
    };
    await db.insert(messages).values(userMsg);

    // Create run record
    const run = {
      id: randomUUID(),
      threadId,
      status: "pending" as const,
      error: null,
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      createdAt: now,
      finishedAt: null,
    };
    await db.insert(runs).values(run);

    // Update thread timestamp
    await db
      .update(threads)
      .set({ updatedAt: now })
      .where(eq(threads.id, threadId));

    return c.json({ run, userMessage: userMsg }, 201);
  },
);

// GET /threads/:threadId/runs - List runs for a thread
threadRoutes.get("/:threadId/runs", async (c) => {
  const threadId = c.req.param("threadId");
  const result = await db
    .select()
    .from(runs)
    .where(eq(runs.threadId, threadId))
    .orderBy(desc(runs.createdAt));
  return c.json(result);
});
