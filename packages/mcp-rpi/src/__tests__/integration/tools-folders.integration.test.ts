/**
 * Integration test: live folder tree walk against a real RPI Integration API.
 *
 * Read-only by design — exercises the same code path as `list_folders` but
 * skips the MCP server harness and calls the cache + walk helpers directly.
 * Skips entirely when env vars are missing or the tenant has zero folders.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { RPIAuthService } from "../../client/rpi-auth.js";
import { RPIApiClient } from "../../client/rpi-api.js";
import type { components } from "../../client/rpi-types.js";
import { FolderCache } from "../../client/folder-cache.js";

type FolderItems = components["schemas"]["FolderStorageItemsJsonResponseMessage"];

// Root .env loader (mirrors tools-selection-rules.integration.test.ts)
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
    `[integration] Skipping folder tool chain — missing env: ${missing.join(", ")}`,
  );
}

describe.skipIf(shouldSkip)("Folders tool chain (live)", () => {
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

  it(
    "walks root folders and at least one level of subfolders",
    { timeout: 30_000 },
    async () => {
      const root = await apiClient.get<FolderItems>(
        undefined,
        "/client/file-system/folders/root-folders",
        undefined,
        { verbose: true },
      );
      const rootFolders = root.folders ?? [];
      console.error(
        `[integration] Folder root-folders returned ${rootFolders.length} item(s)`,
      );
      if (rootFolders.length === 0) {
        console.error(
          "[integration] No root folders in this tenant — skipping deeper walk.",
        );
        return;
      }

      // Confirm shape on the first item
      const first = rootFolders[0];
      expect(first).toBeDefined();
      expect(typeof first.id).toBe("string");
      expect(typeof first.name).toBe("string");

      // Pull subfolders for the first root folder. May legitimately be empty.
      const sub = await apiClient.get<FolderItems>(
        undefined,
        "/client/file-system/folders/subfolders",
        { ID: first.id! },
        { verbose: true },
      );
      const subs = sub.folders ?? [];
      console.error(
        `[integration] Subfolders for "${first.name}" returned ${subs.length} item(s)`,
      );
      if (subs.length > 0) {
        expect(typeof subs[0].id).toBe("string");
        expect(typeof subs[0].name).toBe("string");
        // Note: live RPI returns the all-zero UUID for `parentFolderID` on
        // subfolder listings (does not back-link to the parent). The walk
        // logic in `list_folders` reconstructs the hierarchy from request
        // structure, not from this field.
      }
    },
  );

  it("FolderCache stores and retrieves a snapshot under TTL", () => {
    const cache = new FolderCache(60_000);
    const key = FolderCache.keyFor(
      undefined,
      process.env.RPI_DEFAULT_CLIENT_ID!,
    );
    cache.set(key, [
      { id: "a", name: "A", fullPath: "\\A", parentFolderId: null },
    ]);
    expect(cache.get(key)).toBeDefined();
  });
});
