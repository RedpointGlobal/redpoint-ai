import { describe, it, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RPIApiClient } from "../client/rpi-api.js";
import type { RPIAuthService } from "../client/rpi-auth.js";
import { registerAudienceTools } from "../tools/audiences.js";
import { registerAdminTools } from "../tools/admin.js";
import { registerAuthTools } from "../tools/auth.js";
import { registerClientTools } from "../tools/clients.js";
import { registerFileSystemTools } from "../tools/file-system.js";
import { registerFolderTools } from "../tools/folders.js";
import { registerInteractionTools } from "../tools/interactions.js";
import { registerSelectionRuleTools } from "../tools/selection-rules.js";

// The generator derives the additive skip-set from the hand tools' _meta.endpoints
// (deriveHandEndpoints). That derivation is only complete if EVERY hand tool carries
// a non-empty _meta.endpoints — a hand tool missing it would escape the skip-set and
// risk a duplicate generated tool. This guards that precondition (spec-free).
describe("hand-tool endpoint stamps (generator skip-set derivation)", () => {
  it("every hand-written tool declares a non-empty _meta.endpoints", () => {
    const s = new McpServer({ name: "test-probe", version: "0" });
    const fake = {} as RPIApiClient;
    registerAudienceTools(s, fake);
    registerAdminTools(s, fake);
    registerAuthTools(s, fake, {} as RPIAuthService, null);
    registerClientTools(s, fake);
    registerFileSystemTools(s, fake);
    registerFolderTools(s, fake);
    registerInteractionTools(s, fake);
    registerSelectionRuleTools(s, fake);

    const reg = (
      s as unknown as {
        _registeredTools: Record<string, { _meta?: { endpoints?: string[] } }>;
      }
    )._registeredTools;
    const names = Object.keys(reg);
    expect(names.length).toBe(49);
    const missing = names.filter((n) => !(reg[n]._meta?.endpoints?.length));
    expect(missing).toEqual([]);
  });
});
