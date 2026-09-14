/**
 * Explicit Keycloak redirect_uri (RPI_AI_AGENT_REDIRECT_URL) → AUTH_URL derivation.
 *
 * Auth.js sends the OAuth redirect_uri as `<AUTH_URL-or-origin>/api/auth/callback/
 * keycloak` for BOTH the authorize and token legs, so pinning AUTH_URL to the
 * var's origin makes the sent redirect_uri deterministically equal the var. These
 * lock the selection: env set → reconstructs to exactly the var; unset/invalid →
 * undefined (fall back to origin-derivation, the pre-existing behavior).
 */
import { describe, it, expect } from "bun:test";
import {
  authUrlFromRedirect,
  expectedRedirectUri,
  SSO_CALLBACK_PATH,
} from "../keycloak-sso";

describe("authUrlFromRedirect", () => {
  it("env SET (local) → derives origin; round-trip reconstructs EXACTLY the var", () => {
    const VAR = "http://localhost:3001/api/auth/callback/sso";
    const authUrl = authUrlFromRedirect(VAR);
    expect(authUrl).toBe("http://localhost:3001");
    expect(expectedRedirectUri(authUrl!)).toBe(VAR); // sends exactly that
  });

  it("env SET (prod https) → round-trip reconstructs the var", () => {
    const VAR = "https://agent.example.com/api/auth/callback/sso";
    const authUrl = authUrlFromRedirect(VAR);
    expect(authUrl).toBe("https://agent.example.com");
    expect(expectedRedirectUri(authUrl!)).toBe(VAR);
  });

  it("env UNSET → undefined (fall back to origin-derivation, unchanged)", () => {
    expect(authUrlFromRedirect(undefined)).toBeUndefined();
  });

  it("blank/whitespace → undefined (fall back)", () => {
    expect(authUrlFromRedirect("")).toBeUndefined();
    expect(authUrlFromRedirect("   ")).toBeUndefined();
  });

  it("non-URL garbage → undefined (fail-safe fall back, never a broken AUTH_URL)", () => {
    expect(authUrlFromRedirect("not a url")).toBeUndefined();
    expect(authUrlFromRedirect("/api/auth/callback/sso")).toBeUndefined(); // relative, no origin
  });

  it("the standard callback path constant is correct", () => {
    expect(SSO_CALLBACK_PATH).toBe("/api/auth/callback/sso");
  });

  it("trailing slash on origin doesn't double up in the reconstruction", () => {
    expect(expectedRedirectUri("http://localhost:3001/")).toBe(
      "http://localhost:3001/api/auth/callback/sso",
    );
  });
});
