/**
 * SECURITY guard — the raw upstream response body must NEVER reach a
 * client-facing error. rpi-api + rpi-auth throws carry status + statusText
 * only. This test TRIPS on reintroduction: re-add `${await response.text()}`
 * to any of those throws and the body assertion below goes red.
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import { RPIApiClient } from "../rpi-api.js";
import { RPIAuthService } from "../rpi-auth.js";

const BASE = "https://rpi.example.test";
// A distinctive body carrying exactly the kinds of detail we must not leak.
const SECRET_BODY =
  "SECRET_LEAK_MARKER internal-url=https://internal.host/admin <html>stack trace: at Foo.bar</html> token=abc123";
const realFetch = globalThis.fetch;

function mockFailingFetch(status: number, statusText: string) {
  globalThis.fetch = mock(
    async () => new Response(SECRET_BODY, { status, statusText }),
  ) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("client error leak guard (mcp-rpi)", () => {
  it("RPIApiClient.get error carries status+statusText, NOT the raw body", async () => {
    mockFailingFetch(500, "Internal Server Error");
    const auth = new RPIAuthService(BASE, "cid", "secret");
    const client = new RPIApiClient(BASE, auth, "00000000-0000-0000-0000-000000000000");
    // Pass a user token so the call goes straight to fetch (no proxy-token path).
    let msg = "";
    try {
      await client.get("user-token", "/anything");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("500");
    expect(msg).toContain("Internal Server Error");
    expect(msg).not.toContain("SECRET_LEAK_MARKER");
    expect(msg).not.toContain("internal.host");
    expect(msg).not.toContain("token=abc123");
  });

  it("RPIAuthService.loginUser error carries status+statusText, NOT the raw body", async () => {
    mockFailingFetch(401, "Unauthorized");
    const auth = new RPIAuthService(BASE, "cid", "secret");
    let msg = "";
    try {
      await auth.loginUser("alice", "hunter2");
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain("401");
    expect(msg).not.toContain("SECRET_LEAK_MARKER");
    expect(msg).not.toContain("token=abc123");
  });
});
