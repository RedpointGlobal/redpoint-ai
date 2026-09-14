/**
 * SECURITY guard — the raw upstream response body must NEVER reach a
 * client-facing error. drh-api + drh-auth (signon) throws carry status +
 * statusText only. TRIPS on reintroduction: re-add `${await res.text()}` /
 * `safeText(...)` to those throws and the body assertion below goes red.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { DRHApiClient } from "../drh-api.js";
import { DRHAuthService } from "../drh-auth.js";

const BASE = "https://drh.example.test";
const SECRET_BODY =
  "SECRET_LEAK_MARKER internal-url=https://internal.host/admin <html>stack trace</html> token=abc123";
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("client error leak guard (mcp-drh)", () => {
  it("DRHAuthService.signon error carries status+statusText, NOT the raw body", async () => {
    globalThis.fetch = mock(
      async () => new Response(SECRET_BODY, { status: 401, statusText: "Unauthorized" }),
    ) as unknown as typeof fetch;
    const svc = new DRHAuthService(BASE, "u", "p");
    let msg = "";
    try {
      await svc.signon("x", "y");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("signon failed: 401");
    expect(msg).not.toContain("SECRET_LEAK_MARKER");
    expect(msg).not.toContain("internal.host");
    expect(msg).not.toContain("token=abc123");
  });

  it("DRHApiClient request error carries status+statusText, NOT the raw body", async () => {
    globalThis.fetch = mock(
      async () => new Response(SECRET_BODY, { status: 500, statusText: "Internal Server Error" }),
    ) as unknown as typeof fetch;
    const svc = new DRHAuthService(BASE, "u", "p");
    const client = new DRHApiClient(BASE, svc, "client-1");
    let msg = "";
    try {
      // userToken skips the proxy-token/signon path; goes straight to the failing call.
      await client.request("GET", "/anything", { userToken: "user-token" });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("500");
    expect(msg).not.toContain("SECRET_LEAK_MARKER");
    expect(msg).not.toContain("internal.host");
    expect(msg).not.toContain("token=abc123");
  });
});
