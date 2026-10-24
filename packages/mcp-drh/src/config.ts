import { z } from "zod";

/**
 * DRH (Data Readiness Hub / OP-ServicesAPI) MCP server configuration.
 *
 * DRH's auth model: authentication is Keycloak `signon`/`signoff` (opaque token
 * in the `Authorization` header), and every tool call carries an `X-ClientId`
 * header.
 */
export const DRHConfigSchema = z
  .object({
    /** Root URL of the DRH OP-ServicesAPI (no path suffix; spec paths begin `/api-op/v1/...`). */
    apiUrl: z.string().url(),
    /** Default value for the required `X-ClientId` header; per-call override allowed. */
    defaultClientId: z.string().min(1),
    /**
     * Default database id (numeric), injected as the `databaseId` on database-scoped
     * tools when the caller omits it — the exact twin of `defaultClientId` for the
     * tenant. DR Hub's database is fixed deployment context (set once in the ENV,
     * stable), so it's a configured default, never derived from the prompt. Env
     * `DRH_DEFAULT_DATABASE_ID`.
     */
    defaultDatabaseId: z.number().int().positive().optional(),
    /** Service-account signon (proxy) — the fallback identity when no per-user token is present. */
    proxyEnabled: z.boolean(),
    proxyUser: z.string().min(1).optional(),
    proxyPass: z.string().min(1).optional(),
    /**
     * The FALLBACK cache TTL (seconds) for the proxy sign-on token: the token is
     * cached for 90% of the sign-on reply's `expiresAfter`, and this applies only
     * when the reply has no positive `expiresAfter`. Any 401 also invalidates +
     * re-signons (see DRHApiClient). Env `DRH_TOKEN_TTL_SECONDS`, default 300s.
     */
    tokenTtlSeconds: z.number().int().positive().default(300),
    /** Incoming-request auth gate (enforced by the server middleware). Default ON. */
    authRequired: z.boolean().default(true),
  })
  .refine((c) => !c.proxyEnabled || (!!c.proxyUser && !!c.proxyPass), {
    message: "proxyUser and proxyPass are required when proxyEnabled is true",
  });

export type DRHConfig = z.infer<typeof DRHConfigSchema>;

/**
 * Build a DRHConfig from environment variables, or return null when the DRH
 * backend isn't configured (no DRH_API_URL / DRH_DEFAULT_CLIENT_ID). A null
 * result means the server boots without a live client and exposes no tools
 * (the DR Hub workspace requires credentials). Throws only on a present-but-
 * invalid config (e.g. proxy enabled without creds).
 */
export function loadDrhConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): DRHConfig | null {
  // `DRH_API_URL`: DRH's API is the "OP-ServicesAPI", so the name is the generic
  // DRH_API_URL. Env var names are ours; only the VALUES + wire behavior (Bearer)
  // are dictated by the DRH backend.
  if (!env.DRH_API_URL || !env.DRH_DEFAULT_CLIENT_ID) return null;
  const proxyEnabled = resolveProxyEnabled(env);
  return DRHConfigSchema.parse({
    apiUrl: env.DRH_API_URL,
    defaultClientId: env.DRH_DEFAULT_CLIENT_ID,
    defaultDatabaseId: env.DRH_DEFAULT_DATABASE_ID
      ? Number(env.DRH_DEFAULT_DATABASE_ID)
      : undefined,
    proxyEnabled,
    proxyUser: proxyEnabled ? env.DRH_PROXY_USER : undefined,
    proxyPass: proxyEnabled ? env.DRH_PROXY_PASS : undefined,
    tokenTtlSeconds: env.DRH_TOKEN_TTL_SECONDS
      ? Number(env.DRH_TOKEN_TTL_SECONDS)
      : undefined,
    authRequired: env.AUTH_REQUIRED !== "false",
  });
}

/**
 * Resolve proxy-enabled state from env:
 *   - DRH_PROXY_ENABLED=false → disabled (creds ignored)
 *   - DRH_PROXY_ENABLED=true  → enabled (requires creds, else error)
 *   - unset                   → enabled iff both DRH_PROXY_USER and DRH_PROXY_PASS are set
 */
export function resolveProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const hasCreds = !!env.DRH_PROXY_USER && !!env.DRH_PROXY_PASS;
  const flag = env.DRH_PROXY_ENABLED?.toLowerCase();

  if (flag === "false") return false;
  if (flag === "true") {
    if (!hasCreds) {
      throw new Error(
        "DRH_PROXY_ENABLED=true but DRH_PROXY_USER and/or DRH_PROXY_PASS are not set.",
      );
    }
    return true;
  }
  return hasCreds;
}
