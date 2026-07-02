import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../store/db.js";
import { apiKeys } from "../store/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { generateApiKey, hashApiKey } from "../middleware/auth.js";

export const authRoutes = new Hono();

const CreateApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  workspaceId: z.string().uuid().optional(),
  permissions: z.array(z.string()).optional(),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

// Create a new API key
authRoutes.post(
  "/api-keys",
  zValidator("json", CreateApiKeySchema),
  async (c) => {
    const { name, workspaceId, permissions, expiresInDays } =
      c.req.valid("json");

    const rawKey = generateApiKey();
    const keyHash = await hashApiKey(rawKey);
    const keyPrefix = rawKey.slice(0, 12) + "...";
    const id = randomUUID();

    const expiresAt = expiresInDays
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
      : null;

    await db.insert(apiKeys).values({
      id,
      keyHash,
      keyPrefix,
      name,
      workspaceId: workspaceId ?? null,
      permissions: permissions ? JSON.stringify(permissions) : null,
      createdAt: new Date(),
      expiresAt,
    });

    // Return the raw key only on creation — it cannot be retrieved later
    return c.json(
      {
        id,
        key: rawKey,
        keyPrefix,
        name,
        workspaceId,
        expiresAt: expiresAt?.toISOString() ?? null,
        message:
          "Save this key — it will not be shown again.",
      },
      201,
    );
  },
);

// List API keys (without the actual key values)
authRoutes.get("/api-keys", async (c) => {
  const keys = await db.select({
    id: apiKeys.id,
    keyPrefix: apiKeys.keyPrefix,
    name: apiKeys.name,
    workspaceId: apiKeys.workspaceId,
    createdAt: apiKeys.createdAt,
    expiresAt: apiKeys.expiresAt,
    lastUsedAt: apiKeys.lastUsedAt,
  }).from(apiKeys);

  return c.json(keys);
});

// Delete an API key
authRoutes.delete("/api-keys/:keyId", async (c) => {
  const keyId = c.req.param("keyId");
  const result = await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
  return c.json({ deleted: true });
});
