/**
 * Headers baked into the per-user ephemeral MCP transport (Phase 1a).
 *
 * Its own module (not client.ts) so it can be unit-tested without pulling in the
 * MCP client machinery — and so tests that mock.module("../mcp/client.js") can't
 * shadow this pure helper.
 */

/**
 * The Bearer plus the per-request RPI "Environment Location" as `X-RPI-URL` when
 * set. The URL was already SSRF-allowlist-validated by the app-server auth
 * middleware. Omitting it (no per-request location) is the genuine default path,
 * so a2a/agui/non-interactive forwards (which pass no URL) stay unchanged.
 */
export function ephemeralAuthHeaders(
  userRpiToken: string,
  userRpiUrl?: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${userRpiToken}`,
    ...(userRpiUrl ? { "X-RPI-URL": userRpiUrl } : {}),
  };
}

/** The per-request RPI forwarding context read off the inbound request. */
export interface RpiForwardContext {
  /** The rep's RPI user token (X-RPI-Token), or undefined (→ proxy/no-user path). */
  userRpiToken: string | undefined;
  /** The per-request Environment Location (X-RPI-URL), or undefined (→ env default instance). */
  userRpiUrl: string | undefined;
}

/** Minimal request shape we read — Hono's `Context` satisfies it structurally. */
interface HeaderReader {
  req: { header(name: string): string | undefined };
}

/**
 * Read the per-request RPI forwarding headers (X-RPI-Token + X-RPI-URL) from the
 * inbound request, in ONE place, so every route that spins up MCP tools threads
 * the SAME pair. This closes the class where a route reads x-rpi-token but forgets
 * x-rpi-url — the bug that made the info-panel show MCP "rpi" unreachable (401)
 * whenever a user was on a NON-default Environment Location (the probe validated
 * their token against the default instance). The auth middleware has already
 * SSRF-validated X-RPI-URL upstream. Does NOT include the tenant/activeClientId —
 * that is conversation-resolved (per-conversation store), not an inbound header.
 */
export function readRpiForwardContext(c: HeaderReader): RpiForwardContext {
  return {
    userRpiToken: c.req.header("x-rpi-token") ?? undefined,
    userRpiUrl: c.req.header("x-rpi-url") ?? undefined,
  };
}
