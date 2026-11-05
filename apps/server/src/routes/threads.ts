import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../store/db.js";
import { threads, messages, runs, threadOwners } from "../store/schema.js";
import { and, eq, desc } from "drizzle-orm";
import { randomUUID } from "crypto";
import type { Context } from "hono";
import { callerId, isDevMode } from "../auth/caller.js";

/**
 * The thread `threadId` IN workspace `workspaceId`, if the caller owns it (dev
 * mode: any). Anything else — another user's thread, another workspace's, an
 * unowned legacy thread, no such id — is undefined, and the route answers the same
 * 404, so a thread id can't be probed. Used by every thread route and the agui stream.
 */
export async function findOwnedThread(c: Context, workspaceId: string, threadId: string): Promise<typeof threads.$inferSelect | undefined> {
  const [thread] = await db
    .select()
    .from(threads)
    .where(and(eq(threads.id, threadId), eq(threads.workspaceId, workspaceId)));
  if (!thread) return undefined;
  if (isDevMode()) return thread;
  const [owner] = await db
    .select()
    .from(threadOwners)
    .where(and(eq(threadOwners.threadId, threadId), eq(threadOwners.userId, callerId(c))));
  return owner ? thread : undefined;
}

const THREAD_NOT_FOUND = { error: "Thread not found" } as const;

const CreateThreadSchema = z.object({
  title: z.string().optional(),
});

const CreateRunSchema = z.object({
  message: z.string().min(1),
});

export const threadRoutes = new Hono();

// GET /threads - List the caller's threads in a workspace (dev mode: all)
threadRoutes.get("/", async (c) => {
  const workspaceId = c.req.param("workspaceId")!;
  if (isDevMode()) {
    const all = await db.select().from(threads).where(eq(threads.workspaceId, workspaceId)).orderBy(desc(threads.updatedAt));
    return c.json(all);
  }
  const result = await db
    .select({ thread: threads })
    .from(threads)
    .innerJoin(threadOwners, eq(threadOwners.threadId, threads.id))
    .where(and(eq(threads.workspaceId, workspaceId), eq(threadOwners.userId, callerId(c))))
    .orderBy(desc(threads.updatedAt));
  return c.json(result.map((r: { thread: typeof threads.$inferSelect }) => r.thread));
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
  // The creating identity owns it.
  await db.insert(threadOwners).values({ threadId: thread.id, userId: callerId(c) });
  return c.json(thread, 201);
});

// GET /threads/:threadId - Get thread with messages
threadRoutes.get("/:threadId", async (c) => {
  const threadId = c.req.param("threadId");
  const thread = await findOwnedThread(c, c.req.param("workspaceId")!, threadId);
  if (!thread) return c.json(THREAD_NOT_FOUND, 404);

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
  const existing = await findOwnedThread(c, c.req.param("workspaceId")!, threadId);
  if (!existing) return c.json(THREAD_NOT_FOUND, 404);
  await db.delete(threads).where(eq(threads.id, threadId));
  return c.json({ deleted: true });
});

// POST /threads/:threadId/runs - Create a run
threadRoutes.post(
  "/:threadId/runs",
  zValidator("json", CreateRunSchema),
  async (c) => {
    const threadId = c.req.param("threadId");
    if (!(await findOwnedThread(c, c.req.param("workspaceId")!, threadId))) return c.json(THREAD_NOT_FOUND, 404);
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
  if (!(await findOwnedThread(c, c.req.param("workspaceId")!, threadId))) return c.json(THREAD_NOT_FOUND, 404);
  const result = await db
    .select()
    .from(runs)
    .where(eq(runs.threadId, threadId))
    .orderBy(desc(runs.createdAt));
  return c.json(result);
});
