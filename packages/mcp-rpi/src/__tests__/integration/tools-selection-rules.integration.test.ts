/**
 * Integration test: chained tool flows for selection rules.
 *
 * Flow 1: list_selection_rules → read subTypeName → call the appropriate
 * detail tool (Basic or Standard).
 * Flow 2: list document definitions for the tenant.
 *
 * Skips entirely when env vars are missing. Within each flow, gracefully
 * skips the chain when the live RPI has no data of the required shape.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { RPIAuthService } from "../../client/rpi-auth.js";
import { RPIApiClient } from "../../client/rpi-api.js";
import { searchFileInfos } from "../../client/search.js";

// Root .env loader
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
    `[integration] Skipping selection-rules tool chain — missing env: ${missing.join(", ")}`,
  );
}

describe.skipIf(shouldSkip)("Selection rules tool chain (live)", () => {
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

  it("chained flow: list_selection_rules → inspect subTypeName → call the right detail tool", { timeout: 30_000 }, async () => {
    const listResult = await searchFileInfos<{
      results?: Array<{
        id?: string | null;
        name?: string | null;
        subTypeName?: string | null;
      }>;
    }>(apiClient, undefined, {
      fileTypes: ["Selection Rule"],
      pageSize: 10,
    });
    const list = listResult?.results ?? [];

    if (list.length === 0) {
      console.error(
        "[integration] No selection rules in this RPI instance — skipping chain.",
      );
      return;
    }

    const picked = list.find(
      (x) =>
        x?.id &&
        x?.name &&
        (x.subTypeName === "Basic" || x.subTypeName === "Standard"),
    );
    if (!picked) {
      console.error(
        "[integration] No selection rule had both id/name and a recognized subTypeName — skipping.",
      );
      return;
    }
    console.error(
      `[integration] Chained selection-rules flow picked: id=${picked.id}, name=${picked.name}, subTypeName=${picked.subTypeName}`,
    );

    // Call the appropriate detail endpoint
    const detailPath =
      picked.subTypeName === "Basic"
        ? "/client/files/document-database-decision"
        : "/client/files/standard-selection-rule";

    const detail = await apiClient.get<Record<string, unknown>>(
      undefined,
      detailPath,
      { ID: picked.id! },
    );
    expect(detail).toBeDefined();
    expect(typeof detail).toBe("object");
    console.error(
      `[integration] Detail from ${detailPath} returned shape: ${JSON.stringify(Object.keys(detail ?? {}).slice(0, 8))}`,
    );
  });

  it("list_basic_selection_rule_document_definitions returns from the tenant-wide endpoint", { timeout: 30_000 }, async () => {
    const result = await apiClient.get<Record<string, unknown>>(
      undefined,
      "/client/files/document-database-decision/document-definitions",
    );
    expect(result).toBeDefined();
    expect(typeof result).toBe("object");

    // Log the envelope shape — useful for tuning the client-side filter
    const keys = Object.keys(result ?? {}).slice(0, 8);
    console.error(
      `[integration] document-definitions response shape: ${JSON.stringify(keys)}`,
    );
  });

  it("subType filter returns only Basic rules when subType=Basic", { timeout: 30_000 }, async () => {
    const result = await searchFileInfos<{
      results?: Array<{ subTypeName?: string | null }>;
    }>(apiClient, undefined, {
      fileTypes: ["Selection Rule"],
      subTypes: ["Basic"],
      pageSize: 20,
    });
    const list = result?.results ?? [];
    if (list.length === 0) {
      console.error("[integration] No Basic selection rules — skipping assertion.");
      return;
    }
    for (const item of list) {
      expect(item.subTypeName).toBe("Basic");
    }
    console.error(
      `[integration] subType=Basic returned ${list.length} rule(s), all Basic`,
    );
  });

  it("subType filter returns only Standard rules when subType=Standard", { timeout: 30_000 }, async () => {
    const result = await searchFileInfos<{
      results?: Array<{ subTypeName?: string | null }>;
    }>(apiClient, undefined, {
      fileTypes: ["Selection Rule"],
      subTypes: ["Standard"],
      pageSize: 20,
    });
    const list = result?.results ?? [];
    if (list.length === 0) {
      console.error("[integration] No Standard selection rules — skipping assertion.");
      return;
    }
    for (const item of list) {
      expect(item.subTypeName).toBe("Standard");
    }
    console.error(
      `[integration] subType=Standard returned ${list.length} rule(s), all Standard`,
    );
  });

  it("no subType filter returns a mix of Basic and Standard when both exist", { timeout: 30_000 }, async () => {
    // Pull a larger page so we have a realistic chance of seeing both types
    const result = await searchFileInfos<{
      results?: Array<{ subTypeName?: string | null }>;
    }>(apiClient, undefined, {
      fileTypes: ["Selection Rule"],
      pageSize: 50,
    });
    const list = result?.results ?? [];
    if (list.length === 0) {
      console.error("[integration] No selection rules at all — skipping.");
      return;
    }
    const subTypes = new Set(
      list.map((x) => x.subTypeName).filter((x): x is string => !!x),
    );
    // Every subTypeName present must be one of the expected values
    for (const subType of subTypes) {
      expect(["Basic", "Standard"]).toContain(subType);
    }
    console.error(
      `[integration] No subType filter — saw subTypeNames: ${[...subTypes].join(", ")} (n=${list.length})`,
    );
  });
});
