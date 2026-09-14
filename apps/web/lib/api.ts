const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export interface Workspace {
  id: string;
  name: string;
  description: string | null;
  config: string;
  createdAt: string;
  updatedAt: string;
}

export interface Thread {
  id: string;
  workspaceId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

async function api<T>(path: string, options?: RequestInit, token?: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    // Never cache API reads: in a production Next build, server-component fetches
    // are cached by default, which froze the landing page's workspace list at its
    // first render (during seeding → 1 workspace) and permanently redirected past
    // the multi-workspace picker. Live config/workspace data must always be fresh.
    cache: "no-store",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * List workspaces. Called from the landing page (a SERVER component), so it
 * accepts optional forward headers built server-side by lib/server-forward.ts
 * — under AUTH_REQUIRED=true the gate 401s an unauthenticated read, blanking
 * the picker ("No workspace available"). Under auth=false `forwardHeaders` is
 * empty and this behaves exactly as before.
 */
export async function listWorkspaces(
  forwardHeaders?: Record<string, string>,
): Promise<Workspace[]> {
  return api("/api/v1/workspaces", { headers: forwardHeaders });
}

/**
 * Get one workspace. Client-only caller (workspace/[id] page, info-panel
 * Config tab), so it routes through the same-origin auth-forwarding proxy —
 * the browser sends the HttpOnly session cookie automatically and the proxy
 * attaches the credential server-side (raw token never reaches JS). Mirrors
 * getWorkspaceRuntimeStatus below.
 */
export async function getWorkspace(id: string): Promise<Workspace> {
  const res = await fetch(`/api/proxy/workspaces/${id}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function createWorkspace(data: {
  name: string;
  description?: string;
  provider: { type: string; model: string };
}): Promise<Workspace> {
  return api("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function listThreads(workspaceId: string): Promise<Thread[]> {
  return api(`/api/v1/workspaces/${workspaceId}/threads`);
}

export async function createThread(
  workspaceId: string,
  title?: string,
): Promise<Thread> {
  return api(`/api/v1/workspaces/${workspaceId}/threads`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export interface WorkspaceTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * Get a workspace's tool list (Tools tab). Client-only caller (info-panel), so
 * it routes through the same-origin auth-forwarding proxy — same rationale as
 * getWorkspace above.
 */
export async function getWorkspaceTools(id: string): Promise<WorkspaceTool[]> {
  const res = await fetch(`/api/proxy/workspaces/${id}/tools`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export interface RuntimeStatus {
  tier: "skill-router" | "category-discovery" | "flat";
  providers: Array<{
    type: string;
    name: string;
    configured: boolean;
    missingEnvVar?: string;
  }>;
  mcp: Array<{
    name: string;
    transport: string;
    url?: string;
    connected: boolean;
    supportsFiltering: boolean;
    toolCount: number;
    categories: string[];
    /** Auth outcome of the probe — "none" (no auth required or sent),
     *  "authenticated" (Bearer accepted), "failed" (401/Unauthorized). */
    auth: "none" | "authenticated" | "failed";
    /** Single most-obstructive condition, computed server-side. The UI maps this
     *  to copy and never inspects `error` — wording is the card's business, the
     *  classification is the server's. */
    status: "ok" | "not_configured" | "unauthorized" | "unreachable" | "no_tools";
    /** Env var to name when status is not_configured. */
    missingVar?: string;
    error?: string;
  }>;
  skills: {
    loaded: number;
    experts: number;
    actionable: number;
    details: Array<{
      name: string;
      type: "expert" | "action" | "hybrid";
      toolCount: number;
    }>;
  };
  errors: string[];
  /** Server-global economic-viability instrumentation health (same in every
   *  workspace's panel). Absent on older servers. */
  instrumentation?: {
    enabled: boolean;
    sinkWritable: boolean;
  };
}

export async function getWorkspaceRuntimeStatus(
  id: string,
): Promise<RuntimeStatus> {
  // Routes through the apps/web proxy at /api/proxy/runtime-status/* — the
  // proxy reads the (HttpOnly, server-side-only) NextAuth session cookie,
  // decodes the JWT, and attaches X-RPI-Token to the apps/server upstream.
  // JS code never sees the raw RPI token. Same-origin URL so the browser
  // sends the cookie automatically.
  const res = await fetch(`/api/proxy/runtime-status/${id}`);
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// TelemetryEvent shape — re-exported here so we don't pull `@redpoint-ai/shared`
// directly into the bundle (Next/webpack workspace traversal occasionally
// hiccups; mirroring the type in the consumer is reliable).
export interface TelemetryEvent {
  timestamp: string;
  direction: "ToLLM" | "FromLLM" | "ToMCP" | "FromMCP" | "System";
  type: "generation-start" | "tool-call" | "tool-result" | "step-finish" | "generation-finish";
  toolName?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  tokens?: {
    in?: number;
    out?: number;
    total?: number;
    /** Tokens served from cache (Anthropic ~10x discount; OpenAI/Azure ~2x). */
    cached?: number;
    /** Tokens written into cache on this step (Anthropic-specific). */
    cacheCreated?: number;
  };
  message: string;
  /** "lifecycle" = thread-level framing (visible only in export);
   *  "telemetry" = meaningful step (visible in panel + export). */
  source?: "lifecycle" | "telemetry";
}

export async function getWorkspaceTrace(id: string): Promise<TelemetryEvent[]> {
  return api(`/api/v1/workspaces/${id}/trace`);
}

export function getChatUrl(workspaceId: string): string {
  // Same-origin proxy (apps/web) — proxy reads the HttpOnly session cookie
  // server-side and forwards X-RPI-Token to apps/server. Browser only sees
  // the relative path; the RPI access_token never reaches client JS. The
  // browser sends the session cookie automatically because it's same-origin.
  return `/api/proxy/chat/${workspaceId}`;
}
