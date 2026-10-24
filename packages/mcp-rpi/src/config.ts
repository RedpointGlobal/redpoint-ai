import { z } from "zod";

// An empty value is unset (a deployment pins them empty to state they are unused).
const unsetIfEmpty = (v: unknown) => (v === "" ? undefined : v);

const RPIConfigObject = z.object({
  integrationApiUrl: z.string().url(),
  proxyEnabled: z.boolean(),
  proxyUser: z.string().min(1).optional(),
  proxyPass: z.string().min(1).optional(),
  oauthClientId: z.string().min(1),
  oauthClientSecret: z.string().min(1),
  // Optional: without a default tenant, the caller supplies it per call
  // (client-agnostic endpoints need none; any other call without one fails by name).
  defaultClientId: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
  authRequired: z.boolean().default(true),
});
const proxyCredsRule = [
  (c: { proxyEnabled: boolean; proxyUser?: string; proxyPass?: string }) =>
    !c.proxyEnabled || (!!c.proxyUser && !!c.proxyPass),
  { message: "proxyUser and proxyPass are required when proxyEnabled is true" },
] as const;

export const RPIConfigSchema = RPIConfigObject.refine(...proxyCredsRule);

export type RPIConfig = z.infer<typeof RPIConfigSchema>;

/**
 * LOGIN-ONLY mode — AUTH_REQUIRED=true with the proxy user off. Every RPI call
 * then carries the caller's own token, so the RPI OAuth client (used only to mint
 * tokens by native password grant: the proxy user, or a native login) is not
 * needed; a path that would need it fails with a named error instead.
 */
export const RPILoginOnlyConfigSchema = RPIConfigObject.extend({
  oauthClientId: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
  oauthClientSecret: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
}).refine(...proxyCredsRule);

export type RPILoginOnlyConfig = z.infer<typeof RPILoginOnlyConfigSchema>;

/** The config a server runs with: the full one, or login-only's. */
export type RPIServerConfig = RPIConfig | RPILoginOnlyConfig;

/**
 * Login-only: auth required AND the proxy user resolves disabled. An invalid
 * proxy configuration (RPI_PROXY_ENABLED=true without creds) is NOT login-only —
 * it keeps the full requirements and its own error.
 */
export function isLoginOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AUTH_REQUIRED === "false") return false;
  try {
    return !resolveProxyEnabled(env);
  } catch {
    return false;
  }
}

/** The RPI variables the HTTP server needs but lacks (missing → degraded mode). */
export function missingRpiVarsIn(env: NodeJS.ProcessEnv = process.env): string[] {
  const loginOnly = isLoginOnly(env);
  const missing: string[] = [];
  if (!env.RPI_INTEGRATION_API_URL) missing.push("RPI_INTEGRATION_API_URL");
  if (!loginOnly && !env.RPI_OAUTH_CLIENT_ID) missing.push("RPI_OAUTH_CLIENT_ID");
  if (!loginOnly && !env.RPI_OAUTH_CLIENT_SECRET) missing.push("RPI_OAUTH_CLIENT_SECRET");
  // RPI_DEFAULT_CLIENT_ID is optional in every mode (see defaultClientId above) —
  // except a server pinned to one tenant (../tenant-pin.ts): it has nothing to pin
  // to without it, so it refuses to serve (degraded, /mcp 503) rather than guess.
  if (env.RPI_PIN_CLIENT_ID === "true" && !env.RPI_DEFAULT_CLIENT_ID) missing.push("RPI_DEFAULT_CLIENT_ID");
  return missing;
}

/**
 * The loud line for a server with NO per-user auth that runs every call as the
 * proxy user (AUTH_REQUIRED=false, proxy on) — null otherwise.
 */
export function proxyOnlyBanner(authRequired: boolean, proxyEnabled: boolean, proxyUser: string | undefined): string | null {
  if (authRequired || !proxyEnabled || !proxyUser) return null;
  return `NATIVE RPI CREDENTIALS MODE (testing) — no SSO; every call runs as RPI user ${proxyUser}; not for customer deployments`;
}

/**
 * Resolve proxy-enabled state from env:
 *   - RPI_PROXY_ENABLED=false → disabled (creds ignored)
 *   - RPI_PROXY_ENABLED=true  → enabled (requires creds, else error)
 *   - unset                   → enabled iff both RPI_PROXY_USER and RPI_PROXY_PASS are set
 */
export function resolveProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const hasCreds = !!env.RPI_PROXY_USER && !!env.RPI_PROXY_PASS;
  const flag = env.RPI_PROXY_ENABLED?.toLowerCase();

  if (flag === "false") return false;
  if (flag === "true") {
    if (!hasCreds) {
      throw new Error(
        "RPI_PROXY_ENABLED=true but RPI_PROXY_USER and/or RPI_PROXY_PASS are not set.",
      );
    }
    return true;
  }
  return hasCreds;
}
