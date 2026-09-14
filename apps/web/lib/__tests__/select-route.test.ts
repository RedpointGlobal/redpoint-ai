/**
 * Phase 2 inc 2 — the SSO REDIRECT path's Environment Location carrier route
 * (app/api/rpi-location/select/route.ts). The redirect can't pass a credential,
 * so the login page POSTs the selected URL here before signIn("sso"); this
 * route SSRF-validates and sets/clears the short-TTL carrier cookie the jwt
 * callback reads on the OIDC callback.
 *
 * Locks the binary + fail-safe + determinism matrix that IS unit-testable at the
 * request→response boundary (the jwt-callback read + full redirect round-trip is
 * the live test — it needs NextAuth's OIDC internals). Co-located in lib/__tests__
 * with the other web unit tests so the `bun test lib/__tests__` glob covers it.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { POST } from "@/app/api/rpi-location/select/route";
import { ENV_LOCATION_COOKIE } from "@/lib/env-location";

const saved = process.env.RPI_URL_ALLOWLIST;
afterEach(() => {
  if (saved === undefined) delete process.env.RPI_URL_ALLOWLIST;
  else process.env.RPI_URL_ALLOWLIST = saved;
});

function post(body: unknown, url = "http://localhost:3001/api/rpi-location/select") {
  return POST(
    new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

// Parse the Set-Cookie for the carrier into { value, maxAge, httpOnly, sameSite, secure }.
function carrierCookie(res: Response) {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(new RegExp(`${ENV_LOCATION_COOKIE}=([^;]*)`));
  if (!m) return null;
  const maxAge = raw.match(/Max-Age=(\d+)/i)?.[1];
  return {
    value: decodeURIComponent(m[1]),
    maxAge: maxAge ? Number(maxAge) : undefined,
    httpOnly: /HttpOnly/i.test(raw),
    sameSite: /SameSite=Lax/i.test(raw) ? "lax" : undefined,
    secure: /Secure/i.test(raw),
  };
}

describe("POST /api/rpi-location/select", () => {
  it("valid allowlisted https URL → 200 + fresh HttpOnly SameSite=Lax short-TTL cookie", async () => {
    process.env.RPI_URL_ALLOWLIST = "example.com";
    const res = await post({ url: "https://loc-a.example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const c = carrierCookie(res)!;
    expect(c.value).toBe("https://loc-a.example.com");
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe("lax");
    expect(c.maxAge).toBe(300); // short-lived carrier
    // http request (not https) → not Secure, so it rides localhost dev.
    expect(c.secure).toBe(false);
  });

  it("SSRF-rejected location → 400 location-not-permitted, NO carrier set (binary)", async () => {
    process.env.RPI_URL_ALLOWLIST = "example.com";
    for (const bad of [
      "https://evil.attacker.com", // off-allowlist
      "http://loc-a.example.com", // non-https
      "https://example.com.evil.com", // suffix look-alike
      "not a url", // malformed
    ]) {
      const res = await post({ url: bad });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "location-not-permitted" });
      // A rejected location must NEVER leave a usable carrier behind.
      const c = carrierCookie(res);
      expect(c === null || c.value === "").toBe(true);
    }
  });

  it("blank URL → 200 and CLEARS any stale carrier (Max-Age=0 → env default)", async () => {
    process.env.RPI_URL_ALLOWLIST = "example.com";
    for (const blank of ["", "   ", undefined]) {
      const res = await post({ url: blank });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      const c = carrierCookie(res)!;
      expect(c.value).toBe(""); // cleared
      expect(c.maxAge).toBe(0);
    }
  });

  it("determinism — a second valid select OVERWRITES (no accumulation)", async () => {
    process.env.RPI_URL_ALLOWLIST = "example.com";
    const r1 = carrierCookie(await post({ url: "https://loc-a.example.com" }))!;
    const r2 = carrierCookie(await post({ url: "https://loc-b.example.com" }))!;
    expect(r1.value).toBe("https://loc-a.example.com");
    expect(r2.value).toBe("https://loc-b.example.com"); // fresh value, same cookie name
  });

  it("feature OFF (empty allowlist) → any present URL is 400 (never a carrier)", async () => {
    delete process.env.RPI_URL_ALLOWLIST;
    const res = await post({ url: "https://loc-a.example.com" });
    expect(res.status).toBe(400);
    const c = carrierCookie(res);
    expect(c === null || c.value === "").toBe(true);
  });

  it("secure flag set for an https deployment (SameSite=Lax carrier over TLS)", async () => {
    process.env.RPI_URL_ALLOWLIST = "example.com";
    const res = await post(
      { url: "https://loc-a.example.com" },
      "https://app.example.com/api/rpi-location/select",
    );
    expect(carrierCookie(res)!.secure).toBe(true);
  });

  it("malformed JSON body → treated as blank (clears carrier, no throw)", async () => {
    process.env.RPI_URL_ALLOWLIST = "example.com";
    const res = await POST(
      new Request("http://localhost:3001/api/rpi-location/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      }),
    );
    expect(res.status).toBe(200);
    const c = carrierCookie(res)!;
    expect(c.value).toBe("");
    expect(c.maxAge).toBe(0);
  });
});
