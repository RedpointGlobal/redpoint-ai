/**
 * #27828 — LLM-driven multi-tenant (CLIENT / X-ClientID) switching.
 *
 * "Environment via the location field; TENANT via the LLM." The agent lists the
 * clients the user can reach (existing get_user_client_list) and switches the
 * active one by name. The active client is a PER-CONVERSATION, PER-USER context
 * attribute persisted in the `conversationClients` store, threaded PER-REQUEST
 * into the RPI tool calls (never a process-global) so one conversation's switch
 * cannot repoint another conversation or another user.
 *
 * Composable-target note (Mark's forward-looking design): the per-request tenant
 * is modeled as one clean value alongside the per-request {url, token} the
 * Environment-Location work already threads — so a future cross-ENVIRONMENT
 * ({url,token,clientId} per call) can extend this same pattern. This module owns
 * only the tenant selection; it never touches message/result data, so a future
 * cross-chat data-carry stays open.
 */
import { tool, jsonSchema, type Tool } from "ai";
import { randomUUID } from "crypto";
import { db } from "../store/db.js";
import { conversationClients } from "../store/schema.js";
import { and, eq } from "drizzle-orm";

/** A tenant the user can access, as returned by get_user_client_list. */
export interface AccessibleClient {
  id: string;
  name: string;
}

/** RPI's user-client-list JSON shape (ClusterUserListJsonResponseMessage). */
interface UserClientListResponse {
  clients?: Array<{ id?: string | null; name?: string | null }> | null;
}

/**
 * Normalize an RPI base URL exactly like apps/server/src/middleware/auth.ts:
 * strip a trailing /api/v2 and trailing slash. Keeps the tenant list call on the
 * same instance the rest of the request targets (the Environment Location).
 */
function normalizeBase(raw: string | undefined): string | null {
  if (!raw) return null;
  return raw.replace(/\/api\/v2\/?$/, "").replace(/\/$/, "");
}

/**
 * Fetch the clients the authenticated user can access, RBAC-scoped by RPI itself.
 * Direct REST call (mirrors the auth middleware's validate-token-status fetch) so
 * the switch validates against a clean typed list, on the request's target
 * instance. Returns [] on any failure — the caller treats an empty list as
 * "cannot confirm access" and rejects the switch (fail-closed, never guess).
 */
export async function fetchAccessibleClients(
  userToken: string | undefined,
  targetUrl: string | undefined,
  envDefaultUrl: string | undefined = process.env.RPI_INTEGRATION_API_URL,
): Promise<AccessibleClient[]> {
  const base = normalizeBase(targetUrl) ?? normalizeBase(envDefaultUrl);
  if (!base || !userToken) return [];
  try {
    const res = await fetch(`${base}/api/v2/authentication/user-client-list`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (!res.ok) return [];
    const body = (await res.json()) as UserClientListResponse;
    return (body.clients ?? [])
      .filter((c): c is { id: string; name: string } => !!c?.id && !!c?.name)
      .map((c) => ({ id: c.id, name: c.name }));
  } catch {
    return [];
  }
}

export type TenantResolution =
  | { status: "ok"; client: AccessibleClient }
  | { status: "ambiguous"; matches: AccessibleClient[] }
  | { status: "not-found" };

/**
 * Deterministically resolve a user-supplied target (name or id) against the
 * accessible list. Exact id match wins; else case-insensitive exact name match;
 * else a case-insensitive UNIQUE substring match. Multiple matches → ambiguous
 * (caller ASKS, never guesses). Zero → not-found (caller rejects up front —
 * cannot switch to an inaccessible client). Never partial-guesses a single
 * tenant out of several.
 */
export function resolveTenantSelection(
  clients: AccessibleClient[],
  targetRaw: string,
): TenantResolution {
  const target = targetRaw.trim();
  if (!target) return { status: "not-found" };
  const lc = target.toLowerCase();

  const byId = clients.find((c) => c.id.toLowerCase() === lc);
  if (byId) return { status: "ok", client: byId };

  const byExactName = clients.filter((c) => c.name.toLowerCase() === lc);
  if (byExactName.length === 1) return { status: "ok", client: byExactName[0] };
  if (byExactName.length > 1) return { status: "ambiguous", matches: byExactName };

  const bySubstr = clients.filter((c) => c.name.toLowerCase().includes(lc));
  if (bySubstr.length === 1) return { status: "ok", client: bySubstr[0] };
  if (bySubstr.length > 1) return { status: "ambiguous", matches: bySubstr };

  return { status: "not-found" };
}

// ---------------------------------------------------------------------------
// Per-conversation, per-user store (conversationClients). Keyed by
// (conversationId, userId, workspaceId) so a switch is isolated to that
// conversation AND that user.
// ---------------------------------------------------------------------------

function storeKey(conversationId: string, userId: string, workspaceId: string): string {
  // Deterministic surrogate id so upserts target one row per (convo,user,ws).
  return `${workspaceId}::${userId}::${conversationId}`;
}

/** Read the active client id for a conversation+user, or undefined (→ env default). */
export async function getActiveClient(
  conversationId: string | undefined,
  userId: string,
  workspaceId: string,
): Promise<AccessibleClient | undefined> {
  if (!conversationId) return undefined;
  const [row] = await db
    .select()
    .from(conversationClients)
    .where(
      and(
        eq(conversationClients.conversationId, conversationId),
        eq(conversationClients.userId, userId),
        eq(conversationClients.workspaceId, workspaceId),
      ),
    );
  if (!row) return undefined;
  return { id: row.clientId, name: row.clientName ?? row.clientId };
}

/** Upsert the active client for a conversation+user (deterministic single row). */
export async function setActiveClient(
  conversationId: string,
  userId: string,
  workspaceId: string,
  client: AccessibleClient,
): Promise<void> {
  const id = storeKey(conversationId, userId, workspaceId);
  const now = new Date();
  // Delete-then-insert = portable upsert across SQLite + Postgres without an
  // onConflict clause that differs per driver. One row per key by construction.
  await db.delete(conversationClients).where(eq(conversationClients.id, id));
  await db.insert(conversationClients).values({
    id,
    conversationId,
    userId,
    workspaceId,
    clientId: client.id,
    clientName: client.name,
    updatedAt: now,
  });
}

// ---------------------------------------------------------------------------
// The switch tool — an apps/server ORCHESTRATOR action (NOT an mcp-rpi tool),
// so RBAC validation + per-conversation persistence both live server-side and
// the read-only DATA posture (mcp-rpi's write-gate) never touches it.
// ---------------------------------------------------------------------------

export interface TenantSwitchDeps {
  conversationId: string | undefined;
  userId: string;
  workspaceId: string;
  /** Resolves the caller's RBAC-scoped accessible clients (fail-closed → []). */
  listClients: () => Promise<AccessibleClient[]>;
  /**
   * Called after a successful switch with the new client id, so the caller can
   * update the in-request active-client holder — making the switch apply to
   * SUBSEQUENT RPI tool calls in the SAME turn (not just the next turn's store
   * read). Optional; omit when only the persisted store matters.
   */
  onSwitch?: (clientId: string) => void;
}

function formatList(clients: AccessibleClient[]): string {
  if (clients.length === 0) return "(none)";
  return clients.map((c) => `- ${c.name}`).join("\n");
}

/**
 * Build the `set_active_tenant` tool. Server-side RBAC validate: the target MUST
 * be in the user's accessible list (up-front reject, never trust the LLM's
 * claim); ambiguous → ASK; success → persist per-conversation and confirm. A
 * missing conversationId (no per-conversation key on this request) → refuse
 * gracefully rather than write global state.
 */
export function createTenantSwitchTool(deps: TenantSwitchDeps): Tool {
  return tool({
    description:
      "Switch the active RPI client (tenant) for THIS conversation. Call when the user asks to switch/use/work in a specific tenant by name or id (e.g. 'switch to the Acme tenant'). The target must be one the user can access; subsequent RPI tool calls in this conversation then run against it (X-ClientID). To list accessible tenants, use get_user_client_list instead — this tool only switches.",
    inputSchema: jsonSchema<{ tenant: string }>({
      type: "object",
      properties: {
        tenant: {
          type: "string",
          description: "The target client/tenant — its name or id, as the user expressed it.",
        },
      },
      required: ["tenant"],
      additionalProperties: false,
    }),
    execute: async ({ tenant }: { tenant: string }) => {
      if (!deps.conversationId) {
        return "Can't set a per-conversation tenant: this request carries no conversation id. (No change made.)";
      }
      const clients = await deps.listClients();
      if (clients.length === 0) {
        return "Couldn't retrieve your accessible tenants (or you have none), so the switch was not made. Try again, or check your access.";
      }
      const res = resolveTenantSelection(clients, tenant);
      if (res.status === "not-found") {
        return (
          `"${tenant}" isn't one of the tenants you can access, so I didn't switch. ` +
          `Your accessible tenants:\n${formatList(clients)}`
        );
      }
      if (res.status === "ambiguous") {
        return (
          `"${tenant}" matches more than one tenant — which did you mean?\n${formatList(res.matches)}`
        );
      }
      await setActiveClient(deps.conversationId, deps.userId, deps.workspaceId, res.client);
      // Apply mid-turn: update the in-request active-client holder so subsequent
      // RPI tool calls in THIS same turn already target the switched tenant.
      deps.onSwitch?.(res.client.id);
      return `Switched this conversation's active tenant to ${res.client.name}. Subsequent RPI operations target this tenant AUTOMATICALLY (the server injects its X-ClientID) — do NOT pass the tenant name or a clientId into any further tool call; just call the operation directly. This stays in effect until you switch again.`;
    },
  });
}
