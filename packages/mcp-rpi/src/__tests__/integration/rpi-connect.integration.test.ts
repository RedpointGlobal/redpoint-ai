/**
 * Integration test: real connectivity to the RPI instance configured in the
 * root .env file. Validates that a developer's RPI configuration is correct
 * for the MCP server by exercising the full auth + API flow.
 *
 * Skips silently when any required env var is missing, so default `bun test`
 * runs don't require RPI connectivity.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { RPIAuthService } from "../../client/rpi-auth.js";
import { RPIApiClient } from "../../client/rpi-api.js";
import { resolveProxyEnabled } from "../../config.js";

// Mirror the root-.env loader used by http.ts / index.ts so this test file
// works regardless of which cwd bun test is invoked from.
const __testsDir = dirname(fileURLToPath(import.meta.url));
const rootEnv = join(__testsDir, "../../../../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf("#");
      if (commentIdx > 0) value = value.slice(0, commentIdx).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const REQUIRED = [
  "RPI_INTEGRATION_API_URL",
  "RPI_OAUTH_CLIENT_ID",
  "RPI_OAUTH_CLIENT_SECRET",
  "RPI_DEFAULT_CLIENT_ID",
  "RPI_PROXY_USER",
  "RPI_PROXY_PASS",
] as const;

const missing = REQUIRED.filter((k) => !process.env[k]);
const shouldSkip = missing.length > 0;

if (shouldSkip) {
  console.error(
    `[integration] Skipping RPI integration tests — missing env: ${missing.join(", ")}`,
  );
}

describe.skipIf(shouldSkip)("RPI integration (live)", () => {
  let authService: RPIAuthService;
  let apiClient: RPIApiClient;
  let proxyToken: string;

  beforeAll(async () => {
    authService = new RPIAuthService(
      process.env.RPI_INTEGRATION_API_URL!,
      process.env.RPI_OAUTH_CLIENT_ID!,
      process.env.RPI_OAUTH_CLIENT_SECRET!,
      process.env.RPI_PROXY_USER,
      process.env.RPI_PROXY_PASS,
    );
    apiClient = new RPIApiClient(
      process.env.RPI_INTEGRATION_API_URL!,
      authService,
      process.env.RPI_DEFAULT_CLIENT_ID!,
    );
    proxyToken = await authService.getProxyToken();
  });

  it("resolves proxyEnabled=true from env", () => {
    expect(resolveProxyEnabled()).toBe(true);
  });

  it("RPIAuthService reports proxyEnabled=true", () => {
    expect(authService.proxyEnabled).toBe(true);
  });

  it("getProxyToken returns a non-empty Bearer token", async () => {
    const token = await authService.getProxyToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("getProxyToken caches the token on subsequent calls", async () => {
    const first = await authService.getProxyToken();
    const second = await authService.getProxyToken();
    expect(second).toBe(first);
  });

  it("getLoginSettings reaches the RPI instance and returns an array", async () => {
    // An empty array is valid — some RPI instances have no login methods configured.
    const settings = await authService.getLoginSettings();
    expect(Array.isArray(settings)).toBe(true);
    for (const s of settings) {
      expect(typeof s.authenticationType).toBe("string");
    }
    console.error(
      `[integration] Login methods configured: ${settings.length === 0 ? "(none)" : settings.map((s) => s.authenticationType).join(", ")}`,
    );
  });

  it("validateToken returns true for a freshly-issued proxy token", async () => {
    const token = await authService.getProxyToken();
    const valid = await authService.validateToken(token);
    expect(valid).toBe(true);
  });

  it("validateToken returns false for a bogus token", async () => {
    const valid = await authService.validateToken("not-a-real-token");
    expect(valid).toBe(false);
  });

  it("list_audiences (via searchFileInfos) succeeds with X-ClientID from the default", async () => {
    const { searchFileInfos } = await import("../../client/search.js");
    const result = await searchFileInfos<{ results?: unknown[] }>(
      apiClient,
      proxyToken,
      { fileTypes: ["Audience"], pageSize: 5 },
    );
    expect(Array.isArray(result?.results ?? [])).toBe(true);
    console.error(
      `[integration] list_audiences returned ${(result?.results ?? []).length} item(s) with defaultClientId`,
    );
  });

  it("list_audiences succeeds with an explicit per-call clientId override", async () => {
    const { searchFileInfos } = await import("../../client/search.js");
    const result = await searchFileInfos<{ results?: unknown[] }>(
      apiClient,
      proxyToken,
      { fileTypes: ["Audience"], pageSize: 5 },
      { clientId: process.env.RPI_DEFAULT_CLIENT_ID! },
    );
    expect(Array.isArray(result?.results ?? [])).toBe(true);
  });
});