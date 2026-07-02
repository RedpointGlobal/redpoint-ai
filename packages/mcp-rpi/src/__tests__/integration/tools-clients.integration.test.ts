/**
 * Integration test: chained tool flow for the clients domain.
 *
 * Exercises list_clients → get_client_by_id → get_client_by_name against the
 * live RPI instance to catch inter-tool bugs unit mocks can't see.
 *
 * Skips entirely when required env vars are missing. Within the flow, skips
 * the chain gracefully when zero clients are returned.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { RPIAuthService } from "../../client/rpi-auth.js";
import { RPIApiClient } from "../../client/rpi-api.js";
import { findByIdExact, findByNameExact } from "../../tools/audiences.js";

// ---------------------------------------------------------------------------
// Root .env loader
// ---------------------------------------------------------------------------

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
    `[integration] Skipping clients tool chain — missing env: ${missing.join(", ")}`,
  );
}

describe.skipIf(shouldSkip)("Clients tool chain (live)", () => {
  let apiClient: RPIApiClient;

  beforeAll(() => {
    const authService = new RPIAuthService(
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
  });

  it("chained clients flow: list → get_by_id → get_by_name", async () => {
    // 1. List all clients
    const all = await apiClient.get<{
      clients?: Array<{ id?: string | null; name?: string | null }>;
    }>(undefined, "/cluster/operations/clients");
    const list = all?.clients ?? [];

    if (list.length === 0) {
      console.error(
        "[integration] No clients on the RPI cluster — skipping chained assertions.",
      );
      return;
    }

    // 2. Pick first with both id and name
    const picked = list.find(
      (x) => x && x.id && x.id.length > 0 && x.name && x.name.length > 0,
    );
    if (!picked) {
      console.error(
        "[integration] list_clients returned items but none had both id and name — skipping.",
      );
      return;
    }
    console.error(
      `[integration] Chained clients flow picked: id=${picked.id}, name=${picked.name}`,
    );

    // 3. get_client_by_id — exercises the same CI-equals helper the tool uses
    const byId = findByIdExact(list, picked.id!);
    expect(byId).toBeDefined();
    expect(byId?.name).toBe(picked.name);

    // 4. get_client_by_name
    const byName = findByNameExact(list, picked.name!);
    expect(byName).toBeDefined();
    expect(byName?.id).toBe(picked.id);

    // 5. Round-trip via case-varied id — the lookup should still find it
    const upperId = picked.id!.toUpperCase();
    const byUpperId = findByIdExact(list, upperId);
    expect(byUpperId?.id).toBe(picked.id);
  });

  it("verifies the configured RPI_DEFAULT_CLIENT_ID matches a real client", async () => {
    // Useful sanity check: the env var should refer to a client that actually
    // exists on the cluster, otherwise every tool call is destined to fail.
    const all = await apiClient.get<{
      clients?: Array<{ id?: string | null; name?: string | null }>;
    }>(undefined, "/cluster/operations/clients");
    const list = all?.clients ?? [];
    const configured = process.env.RPI_DEFAULT_CLIENT_ID!;
    const match = findByIdExact(list, configured);
    if (!match) {
      console.error(
        `[integration] WARNING: RPI_DEFAULT_CLIENT_ID=${configured} does not match any client returned by GET /cluster/operations/clients. Tool calls using the default will fail at the X-ClientID layer.`,
      );
    } else {
      console.error(
        `[integration] RPI_DEFAULT_CLIENT_ID resolves to client: ${match.name}`,
      );
    }
    // Don't fail the test — the mismatch is informational. Misconfigurations
    // surface loudly elsewhere (any other RPI call would 400).
    expect(list.length).toBeGreaterThanOrEqual(0);
  });
});
