/**
 * Integration tests: chained tool flows for audiences and audience definitions.
 *
 * Each flow exercises multiple tools in sequence against the live RPI instance
 * to catch inter-tool bugs (mismatched id formats, CI comparison quirks,
 * response-shape assumptions) that mocked unit tests can't see.
 *
 * Skips entirely when required env vars are missing. Within a flow, gracefully
 * skips the chain when the RPI instance returns zero items (logs a message,
 * doesn't fail).
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { RPIAuthService } from "../../client/rpi-auth.js";
import { RPIApiClient } from "../../client/rpi-api.js";
import { searchFileInfos } from "../../client/search.js";
import {
  findByIdExact,
  findByNameExact,
} from "../../tools/audiences.js";

// ---------------------------------------------------------------------------
// Root .env loader (mirrors rpi-connect.integration.test.ts)
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
    `[integration] Skipping audiences tool chain — missing env: ${missing.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Shared harness: real RPIApiClient against the live RPI from .env
// ---------------------------------------------------------------------------

describe.skipIf(shouldSkip)("Audiences tool chain (live)", () => {
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

  // -------------------------------------------------------------------------
  // Audiences: list → get_by_id → get_by_name → metadata
  // -------------------------------------------------------------------------
  it("chained audiences flow: list → get_by_id → get_by_name → metadata", { timeout: 30_000 }, async () => {
    // 1. List
    const listResult = await searchFileInfos<{
      results?: Array<{ id?: string | null; name?: string | null }>;
    }>(apiClient, undefined, {
      fileTypes: ["Audience"],
      pageSize: 5,
    });
    const list = listResult?.results ?? [];

    if (list.length === 0) {
      console.error(
        "[integration] No audiences in this RPI instance — skipping chained assertions.",
      );
      return;
    }

    // 2. Pick first with both id and name
    const picked = list.find(
      (x) => x && x.id && x.id.length > 0 && x.name && x.name.length > 0,
    );
    if (!picked) {
      console.error(
        "[integration] list_audiences returned items but none had both id and name — skipping.",
      );
      return;
    }
    console.error(
      `[integration] Chained audiences flow picked: id=${picked.id}, name=${picked.name}`,
    );

    // 3. get_audience_by_id
    const byId = await apiClient.get<{ id?: string | null; name?: string | null }>(
      undefined,
      "/client/files/audience",
      { ID: picked.id! },
    );
    expect(byId).toBeDefined();
    // Full payload may omit id in some RPI shapes — assert name matches when present
    if (byId?.name != null && picked.name != null) {
      expect(byId.name.toLowerCase()).toBe(picked.name.toLowerCase());
    }

    // 4. get_audience_by_name (search + client-side exact CI match)
    const searchByName = await searchFileInfos<{
      results?: Array<{ id?: string | null; name?: string | null }>;
    }>(apiClient, undefined, {
      fileTypes: ["Audience"],
      searchString: picked.name!,
      pageSize: 255,
    });
    const nameMatch = findByNameExact(
      searchByName?.results ?? [],
      picked.name!,
    );
    expect(nameMatch).toBeDefined();
    expect((nameMatch?.id ?? "").toLowerCase()).toBe(picked.id!.toLowerCase());

    // 5. get_audience_metadata — just verify it returns an object
    const metadata = await apiClient.get<Record<string, unknown>>(
      undefined,
      "/client/files/audience/metadata",
      { ID: picked.id! },
    );
    expect(metadata).toBeDefined();
    expect(typeof metadata).toBe("object");
  });

  // -------------------------------------------------------------------------
  // Audience definitions: list → get_by_id → get_by_name
  // -------------------------------------------------------------------------
  it("chained audience_definitions flow: list → get_by_id → get_by_name", { timeout: 30_000 }, async () => {
    // 1. Fetch all definitions (configuration endpoint has no pagination)
    const all = await apiClient.get<{
      objects?: Array<{ id?: string | null; name?: string | null }>;
    }>(undefined, "/client/configuration/audience-definitions");
    const list = all?.objects ?? [];

    if (list.length === 0) {
      console.error(
        "[integration] No audience definitions in this RPI instance — skipping chained assertions.",
      );
      return;
    }

    // 2. Pick first with both id and name
    const picked = list.find(
      (x) => x && x.id && x.id.length > 0 && x.name && x.name.length > 0,
    );
    if (!picked) {
      console.error(
        "[integration] list_audience_definitions returned items but none had both id and name — skipping.",
      );
      return;
    }
    console.error(
      `[integration] Chained audience_definitions flow picked: id=${picked.id}, name=${picked.name}`,
    );

    // 3. get_audience_definition_by_id — exercises the exact same filter
    //    helper the tool handler uses.
    const byId = findByIdExact(list, picked.id!);
    expect(byId).toBeDefined();
    expect(byId?.name).toBe(picked.name);

    // 4. get_audience_definition_by_name
    const byName = findByNameExact(list, picked.name!);
    expect(byName).toBeDefined();
    expect(byName?.id).toBe(picked.id);
  });
});
