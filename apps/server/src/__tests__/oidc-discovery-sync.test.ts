/**
 * Sync guard for the OIDC discovery + verifier mirror. mcp-rpi is a standalone
 * compiled binary with no @redpoint-ai/shared dependency, so the app server keeps
 * its own copy (apps/server/src/auth/oidc-discovery.ts) of
 * packages/mcp-rpi/src/client/oidc-discovery.ts. The two must stay identical:
 * only the import lines and the server copy's "MIRROR of <path>" header line may
 * differ (the server's own file carries no header, so it stays untouched).
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SERVER_COPY = "apps/server/src/auth/oidc-discovery.ts";
const MCP_COPY = "packages/mcp-rpi/src/client/oidc-discovery.ts";

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf-8").replace(/\r\n?/g, "\n");
/** Drop the lines allowed to differ: imports and the mirror header. */
const normalize = (src: string) =>
  src
    .split("\n")
    .filter((line) => !/^import\s/.test(line) && !/^\s*\*\s*MIRROR of /.test(line))
    .join("\n");

describe("oidc-discovery mirror (apps/server ↔ mcp-rpi)", () => {
  it("the server copy names the mcp-rpi file as its mirror", () => {
    expect(read(SERVER_COPY)).toContain(`MIRROR of ${MCP_COPY} — keep in sync (sync test enforces).`);
  });

  it("the two copies are identical apart from imports and the mirror header", () => {
    expect(normalize(read(SERVER_COPY))).toBe(normalize(read(MCP_COPY)));
  });

  it("the server copy exports the same surface", async () => {
    const server = await import("../auth/oidc-discovery.js");
    expect(typeof server.discoverOidcConfig).toBe("function");
    expect(typeof server.createOidcVerifier).toBe("function");
  });
});
