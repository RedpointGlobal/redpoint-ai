/**
 * #27828 Option B — a mid-turn set_active_tenant switch must apply to the
 * SUBSEQUENT RPI tool calls in the SAME turn.
 *
 * Mechanism: chat.ts holds the active client in a mutable per-request cell
 * (`clientRef`), passes getToolsForWorkspace a GETTER over it, and set_active_tenant's
 * onSwitch mutates the cell right after it persists. The MCP execute wrapper resolves
 * the client id at CALL time via resolveActiveClientId, so a call made after the
 * switch sees the new id.
 *
 * These lock the two pure pieces of that chain — resolveActiveClientId's call-time
 * read, and the exact clientRef+onSwitch wiring chat.ts uses — without standing up a
 * live MCP transport. tenant.test.ts covers onSwitch firing from the real tool.
 */
import { describe, it, expect } from "bun:test";
import { resolveActiveClientId } from "../mcp/client.js";

describe("resolveActiveClientId — call-time resolution", () => {
  it("static string passes through", () => {
    expect(resolveActiveClientId("client-a")).toBe("client-a");
  });

  it("undefined → undefined (caller falls back to RPI_DEFAULT_CLIENT_ID)", () => {
    expect(resolveActiveClientId(undefined)).toBeUndefined();
  });

  it("getter is read at CALL time, not baked when the wrapper is built", () => {
    const ref = { current: "before" as string | undefined };
    const getter = () => ref.current;
    expect(resolveActiveClientId(getter)).toBe("before");
    // Simulate a mid-turn switch mutating the per-request holder.
    ref.current = "after";
    expect(resolveActiveClientId(getter)).toBe("after");
  });

  it("getter over an initially-undefined holder resolves once set", () => {
    const ref = { current: undefined as string | undefined };
    const getter = () => ref.current;
    expect(resolveActiveClientId(getter)).toBeUndefined();
    ref.current = "switched";
    expect(resolveActiveClientId(getter)).toBe("switched");
  });
});

describe("Option B wiring — clientRef + onSwitch (as chat.ts assembles it)", () => {
  it("after the switch, a subsequent call resolves the newly-switched clientId", () => {
    // Mirror chat.ts: a per-request mutable cell, a getter threaded into the MCP
    // wrapper, and onSwitch mutating the cell after a successful switch.
    const clientRef = { current: "tenant-initial" as string | undefined };
    const getter = () => clientRef.current;
    const onSwitch = (clientId: string) => {
      clientRef.current = clientId;
    };

    // First RPI call this turn — sees the conversation's persisted tenant.
    expect(resolveActiveClientId(getter)).toBe("tenant-initial");

    // set_active_tenant runs mid-turn (its onSwitch is called after persisting).
    onSwitch("tenant-switched");

    // Every subsequent RPI call this turn now targets the switched tenant.
    expect(resolveActiveClientId(getter)).toBe("tenant-switched");
  });
});
