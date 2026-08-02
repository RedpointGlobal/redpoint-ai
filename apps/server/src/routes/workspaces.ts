import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { WorkspaceCreateSchema, WorkspaceConfigSchema, WORKSPACE_NAMES } from "@redpoint-ai/shared";
import { db } from "../store/db.js";
import { workspaces } from "../store/schema.js";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";
import { mcpManager } from "../mcp/client.js";
import { resolveTier } from "../agents/tier-resolver.js";
import { extractListToolsCapability } from "../mcp/mcp-category-discovery.js";
import { listProviders } from "../config/providers.js";
import { getSkillRegistry } from "../skills/registry-singleton.js";
import { isDispatchable, isInlinedExpert } from "@redpoint-ai/skills";
import { getTrace, clearTrace, subscribeTrace } from "../lib/trace-buffer.js";

export const workspaceRoutes = new Hono();

// ---------------------------------------------------------------------------
// Runtime-status TTL cache — keyed by workspaceId. 30s window matches typical
// dev-iteration cadence: long enough that a panel re-open within a few seconds
// is free, short enough that stopping/restarting the MCP server reflects
// quickly. Cached value includes the wall-clock timestamp; readers compare.
// ---------------------------------------------------------------------------

const RUNTIME_STATUS_TTL_MS = 30_000;
interface CachedRuntimeStatus {
  value: unknown;
  expires: number;
}
const runtimeStatusCache = new Map<string, CachedRuntimeStatus>();

workspaceRoutes.get("/", async (c) => {
  const result = await db.select().from(workspaces);
  // DRH is an optional module — its card tracks provisioning. When DRH_API_URL
  // (the sentinel: first in the DRH MCP server's missing-vars check) is unset,
  // the Data Readiness Hub workspace is filtered from this list so its card does
  // not render. "Not provisioned" is honest absence, not a diagnostic state, and
  // ~all OSS users are RPI-only — no dead card. Partial config (DRH_API_URL set,
  // other DRH vars missing) still lists the card, which then shows the same
  // not_configured/missingVar treatment RPI gets via runtime-status.
  //
  // READ-PATH ONLY. The row and its threads are never touched, and GET /:id (+
  // /:id/chat, /:id/runtime-status) still resolve it, so a bookmarked chat stays
  // reachable and the card returns intact when keys return. This filter MUST NOT
  // be mirrored into the seed or enforceCanonicalWorkspaces: gating those on
  // DRH_API_URL is the historical data-loss bug (a missing/typo'd/transient var
  // deleting the workspace + reparenting conversations — see store/seed.ts).
  const filtered = process.env.DRH_API_URL
    ? result
    : result.filter(
        (w: typeof workspaces.$inferSelect) => w.name !== WORKSPACE_NAMES.drh,
      );
  return c.json(filtered);
});

workspaceRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id));
  if (!workspace) return c.json({ error: "Not found" }, 404);
  return c.json(workspace);
});

workspaceRoutes.get("/:id/tools", async (c) => {
  const id = c.req.param("id");
  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id));
  if (!workspace) return c.json({ error: "Not found" }, 404);

  const configResult = WorkspaceConfigSchema.safeParse(JSON.parse(workspace.config) as unknown);
  if (!configResult.success) {
    return c.json({ error: "Invalid workspace configuration" }, 400);
  }
  const config = configResult.data;

  // Unreachable MCP server: report it as an explicit, machine-readable state
  // rather than a 500 — this endpoint backs the Tools tab, which is one of the
  // surfaces a user opens precisely to find out why tools are missing.
  let tools: Awaited<ReturnType<typeof mcpManager.getToolsForWorkspace>> = {};
  try {
    if (config.mcp?.length) {
      // Bounded like the runtime-status probe below: an unreachable server
      // stalls rather than throwing, so without a fuse this endpoint hangs.
      tools = await Promise.race([
        mcpManager.getToolsForWorkspace(id, config.mcp),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("tool load timed out after 10s — server may be down")),
            10_000,
          ),
        ),
      ]);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[workspaces] tools unavailable for ${id}: ${detail}`);
    return c.json({ error: "mcp_unavailable", detail, tools: [] }, 503);
  }

  const list = Object.entries(tools).map(([name, tool]) => ({
    name,
    description: tool.description ?? "",
    inputSchema: (tool as { inputSchema?: unknown }).inputSchema ?? null,
  }));

  return c.json(list);
});

// ---------------------------------------------------------------------------
// Trace — per-workspace ring buffer of TelemetryEvents emitted by the chat /
// agui routes' onStepFinish/onFinish/onError callbacks. Shape verbatim from
// the terminal agent so a web export and a terminal export are drop-in
// interchangeable. The Traffic tab's Export button fetches this on demand.
//
// `?clear=1` empties the buffer after returning the events — useful as a
// "reset" combined with the DevToolsHooks Clear button on the client.
// ---------------------------------------------------------------------------

workspaceRoutes.get("/:id/trace", async (c) => {
  const id = c.req.param("id");
  const events = getTrace(id);
  if (c.req.query("clear") === "1") {
    clearTrace(id);
  }
  return c.json(events);
});

// SSE channel — pushes every TelemetryEvent appended to this workspace's
// trace buffer to live subscribers. The web Traffic tab opens an
// EventSource on this endpoint to keep its display in sync with the rich
// server-captured trace (otherwise the live panel only sees DevToolsHooks
// thread-lifecycle events, not tool-call / tool-result / step-finish).
//
// Backlog handling: on connect, we replay the existing buffer first so a
// late-joining client sees prior events from the current run before any
// new ones arrive. Then we subscribe to live appends.
workspaceRoutes.get("/:id/trace/stream", (c) => {
  const id = c.req.param("id");

  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: unknown) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        };

        // Replay existing buffer so the client picks up events that fired
        // before it connected.
        for (const ev of getTrace(id)) send(ev);

        // Live fan-out
        const unsub = subscribeTrace(id, send);

        // Heartbeat every 25s to keep proxies / browsers from idle-closing
        // the SSE stream. Browsers don't surface SSE comments to listeners,
        // so this is invisible to client code.
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(`: ping\n\n`));
          } catch {
            clearInterval(heartbeat);
          }
        }, 25_000);

        // Tear down on client disconnect
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          unsub();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
});

// ---------------------------------------------------------------------------
// Runtime status — aggregates the live state the web Config tab needs to
// match terminal-agent parity (active tier, providers configured, MCP
// handshake result, skills with tool counts, A2A status, errors).
//
// Cached per workspace for 30s. Cache miss does the live MCP probe; cache
// hit is a Map lookup.
// ---------------------------------------------------------------------------

workspaceRoutes.get("/:id/runtime-status", async (c) => {
  const id = c.req.param("id");

  // Per-user RPI auth — when the web client is logged in via the rpi-native
  // NextAuth provider, the chat-panel forwards `X-RPI-Token` on every chat
  // request. Mirror that here so the discovery probe (a) carries the user's
  // identity, and (b) we can flip the per-server auth label from "none" to
  // "authenticated" when the probe succeeded with a user token. Without this
  // forwarding, the panel reads "Auth: none required" even after a successful
  // login because the probe runs against the proxy-user fallback path.
  //
  // The cache key is also tagged with a short token marker so authenticated
  // and unauthenticated probes don't clobber each other in the cache.
  const userRpiToken = c.req.header("x-rpi-token") ?? undefined;
  const cacheTag = userRpiToken ? `auth:${userRpiToken.slice(-8)}` : "anon";
  const cacheKey = `${id}::${cacheTag}`;
  const cached = runtimeStatusCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return c.json(cached.value);
  }

  const [workspace] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id));
  if (!workspace) return c.json({ error: "Not found" }, 404);

  const configResult = WorkspaceConfigSchema.safeParse(JSON.parse(workspace.config) as unknown);
  if (!configResult.success) {
    return c.json({ error: "Invalid workspace configuration" }, 400);
  }
  const config = configResult.data;

  const errors: string[] = [];

  // Skills resolution — same code path chat.ts/agui.ts use, so the tier we
  // report matches what the dispatcher would compute.
  const registry = await getSkillRegistry();
  const workspaceSkills = config.skills?.length
    ? registry.filterByNames(config.skills)
    : registry.list();

  // MCP per-connection probe — discover tools (catches connection errors per
  // server) AND read the captured serverCapabilities for filtering support.
  type McpStatus = {
    name: string;
    transport: string;
    url?: string;
    connected: boolean;
    supportsFiltering: boolean;
    toolCount: number;
    /** Category names from the server's listTools.availableCategories advertisement,
     *  e.g. ["audiences", "campaigns", "workflows"]. Empty if no categories. */
    categories: string[];
    /** Auth outcome of the probe.
     *  - "none": connected without sending a Bearer (server didn't require auth,
     *    or this code path doesn't yet forward user tokens — current dev posture)
     *  - "authenticated": Bearer was sent and the handshake succeeded (future,
     *    once runtime-status forwards c.get("user") tokens to MCP)
     *  - "failed": probe got a 401/Unauthorized response from the MCP server
     */
    auth: "none" | "authenticated" | "failed";
    /** Single most-obstructive condition, for the workspace card. See classify below. */
    status: "ok" | "not_configured" | "unauthorized" | "unreachable" | "no_tools";
    /** First missing env var name when status is not_configured (card shows this one). */
    missingVar?: string;
    error?: string;
  };
  const mcpStatuses: McpStatus[] = [];
  // Per-connection tools indexed by serverName for skill tool-count derivation.
  const toolsByServer = new Map<string, string[]>();

  for (const conn of config.mcp ?? []) {
    let connected = false;
    let toolCount = 0;
    let connError: string | undefined;
    const toolsForThisServer: string[] = [];

    try {
      // 5s probe timeout — the underlying MCP transport's default is 30s
      // which makes a dead server hang the panel for half a minute. Promise.race
      // with our own short fuse gives the UI a snappy "unreachable" diagnostic
      // instead. The failure result is then cached by the 30s TTL so we don't
      // re-probe for every panel open while MCP is still down.
      const tools = await Promise.race([
        // Forward the user's RPI Bearer (when logged in via rpi-native) so
        // the probe runs as the user. Falls through to the proxy path when
        // userRpiToken is undefined — pre-PR behavior preserved for callers
        // that don't carry a session.
        mcpManager.getToolsForWorkspace(id, [conn], userRpiToken),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("probe timeout after 5s — server may be down")),
            5_000,
          ),
        ),
      ]);
      connected = true;
      toolCount = Object.keys(tools).length;
      for (const fullName of Object.keys(tools)) {
        const baseName = fullName.includes("__") ? fullName.split("__").pop()! : fullName;
        toolsForThisServer.push(baseName);
      }
    } catch (e) {
      connError = e instanceof Error ? e.message : String(e);
      errors.push(`MCP "${conn.name}" unreachable: ${connError}`);
    }
    toolsByServer.set(conn.name, toolsForThisServer);

    const transport = mcpManager.getTransport(id, conn.name);
    const cap = transport ? extractListToolsCapability(transport) : null;
    const supportsFiltering = !!cap?.supportsFiltering;
    const categories = cap?.availableCategories?.map((c) => c.name) ?? [];

    // Auth outcome:
    //   "authenticated" — probe carried the user's RPI Bearer AND succeeded
    //                     (the per-user auth path is provably live for this
    //                     server). The connected check matters: a successful
    //                     proxy-fallback probe with no user token doesn't earn
    //                     this label.
    //   "failed"        — probe carried (or implicitly required) auth and the
    //                     error string is unambiguously 401/Unauthorized-shaped.
    //                     ECONNREFUSED / timeouts / parse errors don't qualify.
    //   "none"          — default. Either no user token was sent, or the probe
    //                     ran against the proxy-fallback successfully.
    let auth: "none" | "authenticated" | "failed" = "none";
    if (connError && /\b401\b|\bUnauthorized\b|Missing.+Authorization/i.test(connError)) {
      auth = "failed";
    } else if (connected && userRpiToken) {
      auth = "authenticated";
    }

    // Ask the MCP server whether it booted unconfigured — ONLY on the unhappy
    // path. A probe that succeeded with tools is definitionally fine, so the
    // healthy path pays nothing. The budget is a 1.5s SLICE, deliberately not a
    // second full fuse: a dead server would otherwise cost 5s + 5s serially and
    // double the wait on exactly the case this reports.
    let missingVar: string | undefined;
    if ((!connected || toolCount === 0) && conn.url) {
      try {
        const healthUrl = conn.url.replace(/\/mcp\/?$/, "/health");
        const res = await Promise.race([
          fetch(healthUrl),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("health timeout")), 1_500),
          ),
        ]);
        if (res.ok) {
          const h = (await res.json()) as { mcp?: string; missing?: string[] };
          if (h.mcp === "degraded") missingVar = h.missing?.[0];
        }
      } catch {
        // Health unreachable too — leave missingVar unset; the probe result
        // below already classifies this as unreachable.
      }
    }

    // ORDER IS DELIBERATE AND LOOKS INVERTED. You reach a server before you
    // authenticate to it, so handshake order would suggest unreachable first.
    // It is the other way round because `unreachable` is the CATCH-ALL for any
    // probe failure — and a 401 also makes the probe fail. Test the specific
    // signals before the catch-all or the unauthorized branch becomes dead code.
    // Do not reorder to "match the handshake"; that silently kills a state.
    const status: McpStatus["status"] = missingVar
      ? "not_configured"
      : auth === "failed"
        ? "unauthorized"
        : !connected
          ? "unreachable"
          : toolCount === 0
            ? "no_tools"
            : "ok";

    mcpStatuses.push({
      name: conn.name,
      transport: conn.transport,
      url: conn.url,
      connected,
      supportsFiltering,
      toolCount,
      categories,
      auth,
      status,
      ...(missingVar ? { missingVar } : {}),
      ...(connError ? { error: connError } : {}),
    });
  }

  const tier = resolveTier(
    workspaceSkills,
    mcpStatuses.map((m) => ({ supportsFiltering: m.supportsFiltering })),
  );

  // Per-skill tool count: explicit mcpToolFilter wins; otherwise the skill gets
  // dynamic discovery (all tools across all connected servers).
  const totalToolCount = mcpStatuses.reduce((sum, m) => sum + m.toolCount, 0);
  const skillsDetail = workspaceSkills.map((s) => ({
    name: s.name,
    type: s.type,
    toolCount:
      s.type === "expert"
        ? 0
        : s.mcpToolFilter
          ? s.mcpToolFilter.length
          : totalToolCount,
  }));
  const skillsSummary = {
    loaded: workspaceSkills.length,
    experts: workspaceSkills.filter(isInlinedExpert).length,
    actionable: workspaceSkills.filter(isDispatchable).length,
    details: skillsDetail,
  };

  // Provider availability — surfaces missing env vars (RPI terminal agent's diagnostic ask)
  const providers = listProviders();

  const result = {
    tier,
    providers,
    mcp: mcpStatuses,
    skills: skillsSummary,
    errors,
  };

  runtimeStatusCache.set(cacheKey, {
    value: result,
    expires: Date.now() + RUNTIME_STATUS_TTL_MS,
  });

  return c.json(result);
});

workspaceRoutes.post(
  "/",
  zValidator("json", WorkspaceCreateSchema),
  async (c) => {
    const body = c.req.valid("json");
    const now = new Date();
    const workspace = {
      id: randomUUID(),
      name: body.name,
      description: body.description ?? null,
      config: JSON.stringify({
        provider: body.provider,
        agent: body.agent,
        mcp: body.mcp,
        skills: body.skills,
        suggestions: body.suggestions,
      }),
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(workspaces).values(workspace);
    return c.json(workspace, 201);
  },
);

workspaceRoutes.put(
  "/:id",
  zValidator("json", WorkspaceCreateSchema),
  async (c) => {
  const id = c.req.param("id");
  const body = c.req.valid("json");
  const now = new Date();
  await db
    .update(workspaces)
    .set({
      name: body.name,
      description: body.description,
      config: JSON.stringify({
        provider: body.provider,
        agent: body.agent,
        mcp: body.mcp,
        skills: body.skills,
        suggestions: body.suggestions,
      }),
      updatedAt: now,
    })
    .where(eq(workspaces.id, id));
  const [updated] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id));
  if (!updated) return c.json({ error: "Not found" }, 404);
  return c.json(updated);
});

workspaceRoutes.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const [existing] = await db
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, id));
  if (!existing) return c.json({ error: "Not found" }, 404);
  await db.delete(workspaces).where(eq(workspaces.id, id));
  return c.json({ deleted: true });
});
