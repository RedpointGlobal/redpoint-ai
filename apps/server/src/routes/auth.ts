import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../store/db.js";
import { apiKeys, apiKeyOwners } from "../store/schema.js";
import { and, eq } from "drizzle-orm";
import { callerId, isDevMode } from "../auth/caller.js";
import { keyMints } from "../lib/web-limits.js";
import { tooManyRequests } from "../lib/rate-limit.js";
import { randomUUID } from "crypto";
import { generateApiKey, hashApiKey } from "../middleware/auth.js";

export const authRoutes = new Hono();

/**
 * API keys (B4). A key belongs to the identity that minted it and acts AS that
 * owner (middleware/auth.ts): it reaches the owner's own data, and only its
 * workspace when it names one. Only a non-key caller may mint one (a key can't
 * mint keys, so a leaked key can't replace itself); a caller lists and revokes its
 * OWN keys. Every key expires: 90 days by default, 365 at most. (The old
 * `permissions` field was never enforced and is no longer accepted.)
 */
const DEFAULT_EXPIRY_DAYS = 90;

const CreateApiKeySchema = z
  .object({
    name: z.string().min(1).max(255),
    workspaceId: z.string().uuid().optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();

// Create a new API key (a non-key caller only)
authRoutes.post(
  "/api-keys",
  zValidator("json", CreateApiKeySchema),
  async (c) => {
    // Dev mode's local user carries the apikey type but is the operator, not a key.
    if (!isDevMode() && c.get("user")?.type === "apikey") {
      return c.json({ error: "An API key can't create API keys" }, 403);
    }
    // At most MAX_KEY_MINTS_PER_HOUR keys an hour per caller (lib/web-limits.ts).
    const minted = keyMints.take(callerId(c));
    if (!minted.ok) return tooManyRequests(c, minted.retryAfterSec);
    const { name, workspaceId, expiresInDays } = c.req.valid("json");

    const rawKey = generateApiKey();
    const keyHash = await hashApiKey(rawKey);
    const keyPrefix = rawKey.slice(0, 12) + "...";
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + (expiresInDays ?? DEFAULT_EXPIRY_DAYS) * 24 * 60 * 60 * 1000);

    await db.insert(apiKeys).values({
      id,
      keyHash,
      keyPrefix,
      name,
      workspaceId: workspaceId ?? null,
      permissions: null,
      createdAt: new Date(),
      expiresAt,
    });
    await db.insert(apiKeyOwners).values({ keyId: id, userId: callerId(c) });

    // Return the raw key only on creation — it cannot be retrieved later
    return c.json(
      {
        id,
        key: rawKey,
        keyPrefix,
        name,
        workspaceId,
        expiresAt: expiresAt.toISOString(),
        message:
          "Save this key — it will not be shown again.",
      },
      201,
    );
  },
);

// List the caller's own API keys (without the actual key values)
authRoutes.get("/api-keys", async (c) => {
  const rows = await db
    .select({
      id: apiKeys.id,
      keyPrefix: apiKeys.keyPrefix,
      name: apiKeys.name,
      workspaceId: apiKeys.workspaceId,
      createdAt: apiKeys.createdAt,
      expiresAt: apiKeys.expiresAt,
      lastUsedAt: apiKeys.lastUsedAt,
    })
    .from(apiKeys)
    .innerJoin(apiKeyOwners, eq(apiKeyOwners.keyId, apiKeys.id))
    .where(eq(apiKeyOwners.userId, callerId(c)));

  return c.json(rows);
});

// Revoke one of the caller's own API keys (another's: the same 404 as no such key)
authRoutes.delete("/api-keys/:keyId", async (c) => {
  const keyId = c.req.param("keyId");
  const [owned] = await db
    .select()
    .from(apiKeyOwners)
    .where(and(eq(apiKeyOwners.keyId, keyId), eq(apiKeyOwners.userId, callerId(c))));
  if (!owned) return c.json({ error: "API key not found" }, 404);
  await db.delete(apiKeys).where(eq(apiKeys.id, keyId));
  return c.json({ deleted: true });
});
