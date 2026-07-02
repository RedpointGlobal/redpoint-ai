/**
 * Module augmentation for NextAuth v5 (Auth.js) types.
 *
 * NextAuth's interfaces (User, Session, JWT) extend `Record<string, unknown>`,
 * so they technically allow arbitrary fields at runtime — but TS won't see
 * those fields unless we declare them here. This file teaches the type
 * system the shape of OUR extensions:
 *
 *   - User: returned from authorize() in a Credentials provider; the
 *     `apiKey` (API-key path) and `rpi*` (RPI native path) fields end up
 *     in the JWT via the jwt callback.
 *
 *   - Session: returned from useSession() / auth(); the session callback
 *     selectively projects JWT fields into the session. Our additions are
 *     `apiKey` (top-level) and `rpi.{username, accessToken}` (sub-object).
 *
 *   - JWT: stored encrypted in the session cookie. All RPI-related fields
 *     live here; only `username` and `accessToken` cross over into the
 *     session (the refresh_token and expires_at stay JWT-only — they
 *     belong server-side to the refresh logic, not to JS consumers).
 *
 * Boundary-cast caveat: the v5 augmentation chain (next-auth → @auth/core)
 * doesn't reliably propagate inside the auth.ts callbacks themselves, so
 * those write through `as Record<string, unknown>` casts. The augmentation
 * is still useful for downstream consumers (RpiHeaderAffordance, future
 * chat-panel forwarding logic, etc.) where it works correctly.
 */

import "next-auth";

declare module "next-auth" {
  interface User {
    apiKey?: string;
    rpiAccessToken?: string;
    rpiRefreshToken?: string;
    rpiExpiresAt?: number;
  }
  interface Session {
    apiKey?: string;
    rpi?: {
      username?: string;
      /**
       * NOTE: `accessToken` was exposed here in PR 2 so the chat-panel could
       * attach it as a Bearer header. As of the cookie-only hardening it is
       * no longer projected into the session — the RPI token stays in the
       * JWT only and is read server-side by the proxy route handlers under
       * apps/web/app/api/proxy/*. JS code never sees the raw token; XSS
       * exfiltration surface for the RPI access token is closed.
       */
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    apiKey?: string;
    rpiUsername?: string;
    rpiAccessToken?: string;
    rpiRefreshToken?: string;
    /** Epoch ms when access_token expires; refreshed lazily in jwt callback. */
    rpiExpiresAt?: number;
  }
}
