/**
 * Tenant pinning: the server runs every call in ONE tenant, its configured
 * RPI_DEFAULT_CLIENT_ID. A per-call `clientId` that names another tenant is
 * refused (RPIApiClient), never silently swapped, so a caller can't believe it
 * reads another tenant's data. Off by default (an unpinned deployment lets a
 * call pick its tenant).
 *
 * The BEHAVIOR can be compiled in: the hardened pinned image builds with
 * `--define process.env.RPI_PIN_CLIENT_ID="true"`, which replaces only a LITERAL
 * `process.env.RPI_PIN_CLIENT_ID` read — so this reads it literally, and no
 * environment can turn the pin off there. The tenant VALUE stays deployment data
 * (RPI_DEFAULT_CLIENT_ID in the .env): one image serves every customer pinned
 * to its one tenant. A pinned server with no tenant refuses to serve (config.ts →
 * degraded, /mcp 503).
 */
export function tenantPinned(): boolean {
  return process.env.RPI_PIN_CLIENT_ID === "true";
}

/** The refusal a pinned server answers a cross-tenant call with. */
export const TENANT_PIN_REFUSAL =
  "RPI client ID not permitted: this server is pinned to its configured tenant (RPI_PIN_CLIENT_ID). Omit clientId to use it.";
