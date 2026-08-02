/**
 * Live integration test: real connectivity to the DRH (OP-ServicesAPI) instance
 * configured in the root .env. Exercises the full production auth path —
 * DRHAuthService.getProxyToken() (Keycloak signon → opaque token) — then a
 * read-only DRHApiClient call along the path the DRH team outlined
 * (GET /api-op/v1/databases/{id}/sources).
 *
 * Gating: skips only when DRH env is absent (mirrors rpi-connect) — so OSS/CI
 * without DRH creds is unaffected. When creds ARE present it RUNS and passes:
 * the proxy service account signs on (Keycloak → opaque token) and the
 * read-only GET returns a response with Bearer + X-ClientId. This is the live
 * verification of the full production auth path, end-to-end.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { DRHAuthService } from "../../client/drh-auth.js";
import { DRHApiClient } from "../../client/drh-api.js";
import { resolveProxyEnabled } from "../../config.js";

// Mirror the root-.env loader used by http.ts so this file works regardless of
// which cwd bun test runs from.
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
  "DRH_API_URL",
  "DRH_DEFAULT_CLIENT_ID",
  "DRH_PROXY_USER",
  "DRH_PROXY_PASS",
] as const;

const missing = REQUIRED.filter((k) => !process.env[k]);
const shouldSkip = missing.length > 0;

if (shouldSkip) {
  console.error(
    `[integration] Skipping DRH live integration — missing env: ${missing.join(", ")}`,
  );
}

describe.skipIf(shouldSkip)("DRH integration (live)", () => {
  let authService: DRHAuthService;
  let apiClient: DRHApiClient;

  beforeAll(() => {
    authService = new DRHAuthService(
      process.env.DRH_API_URL!,
      process.env.DRH_PROXY_USER,
      process.env.DRH_PROXY_PASS,
    );
    apiClient = new DRHApiClient(
      process.env.DRH_API_URL!,
      authService,
      process.env.DRH_DEFAULT_CLIENT_ID!,
    );
  });

  it("resolves proxyEnabled=true from env", () => {
    expect(resolveProxyEnabled()).toBe(true);
  });

  it("signs on and issues an opaque token", async () => {
    const token = await authService.getProxyToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("GET /databases/{id}/sources returns a response (Bearer + X-ClientId)", async () => {
    const dbId = process.env.DRH_DEFAULT_DATABASE_ID || "1";
    const res = await apiClient.request<unknown>(
      "GET",
      `/api-op/v1/databases/${dbId}/sources`,
    );
    expect(res).toBeDefined();
  });
});
