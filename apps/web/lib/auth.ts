/**
 * NextAuth (v5 / Auth.js) configuration for the RP_AI web app.
 *
 * Two distinct identity layers live in the same NextAuth session, on purpose:
 *
 *   1. APP IDENTITY ("apiKey" credentials provider, id: "credentials")
 *      Authenticates the caller against apps/server using a platform-issued
 *      API key (rpai_…). This gates access to /api/v1/* on apps/server.
 *      Pre-existing in this file before per-user RPI work.
 *
 *   2. RPI IDENTITY ("rpi-native" credentials provider, id: "rpi-native")
 *      Logs the user in to RPI directly via OAuth2 password grant against
 *      RPI's /connect/token endpoint. The resulting access_token will be
 *      forwarded on chat-driven MCP tool calls (PR 2 of this work) so RPI
 *      applies the user's per-user RBAC instead of the shared service-account
 *      proxy. Without this, every chat hits RPI as the proxy user.
 *
 * Both identities are stored in the same encrypted JWT cookie (signed/
 * encrypted with AUTH_SECRET via NextAuth's iron-session-style envelope).
 * The browser holds the COOKIE; what JS code can read about the session is
 * controlled explicitly by the `session` callback below.
 *
 * Token lifecycle for RPI identity is handled here in the `jwt` callback:
 * lazy refresh near expiry, drop on refresh rejection. No background timers,
 * no cross-instance state — fits a serverless / multi-instance deployment.
 */

import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

// apps/server URL — used by the API-key Credentials provider to validate
// platform-issued API keys against /api/v1/providers.
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

/**
 * RPI's OAuth token endpoint lives at the API ROOT, not under /api/v2/.
 * If the configured RPI_INTEGRATION_API_URL contains a /api/v2 suffix,
 * strip it so we hit /connect/token correctly.
 *
 * Returns null if RPI_INTEGRATION_API_URL is not configured — in that case
 * the rpi-native provider's authorize() will refuse to attempt login.
 */
function rpiTokenEndpoint(): string | null {
  const raw = process.env.RPI_INTEGRATION_API_URL;
  if (!raw) return null;
  const base = raw.replace(/\/api\/v2\/?$/, "").replace(/\/$/, "");
  return `${base}/connect/token`;
}

/**
 * Wire-format response from RPI's /connect/token endpoint.
 * Field names are snake_case (OAuth2 spec); we keep them as-is to make the
 * mapping to RPI's docs visually obvious.
 *
 * Note: refresh_token is OPTIONAL — not all RPI tenants (some IdentityServer
 * configurations) issue refresh tokens. The `jwt` callback handles its
 * absence by simply skipping refresh and waiting for re-login on expiry.
 */
interface RpiTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * How early before `expires_in` we proactively refresh the access token.
 * 60 seconds matches MIN_TOKEN_TTL_SECONDS in
 * packages/mcp-rpi/src/client/rpi-auth.ts:34 — by sharing the constant value
 * (not the import) we keep the proxy-user and per-user paths in lockstep on
 * staleness threshold without introducing a cross-package import.
 */
const RPI_REFRESH_MARGIN_MS = 60_000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      id: "credentials",
      name: "API Key",
      credentials: {
        apiKey: { label: "API Key", type: "password" },
      },
      async authorize(credentials) {
        const apiKey = credentials?.apiKey;
        if (!apiKey || typeof apiKey !== "string") return null;

        try {
          const res = await fetch(`${API_URL}/api/v1/providers`, {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (!res.ok) return null;
          return { id: "user", name: "API User", apiKey };
        } catch {
          return null;
        }
      },
    }),
    /**
     * RPI native auth — OAuth2 password grant against RPI's /connect/token.
     *
     * Signed in via signIn("rpi-native", { username, password }) from the
     * LoginModal component. Returns a User object whose extra fields (rpi*)
     * land in the JWT via the `jwt` callback below.
     *
     * Returns null on any failure (bad creds, network error, missing env).
     * NextAuth interprets null as "auth failed" and surfaces an error to the
     * caller of signIn(), which the modal renders as "Login failed".
     *
     * NOTE: This is the same wire-level password grant documented in
     * docs/rpi-mcp-server.md#authentication. We do NOT import RPIAuthService
     * from packages/mcp-rpi because apps/web doesn't depend on that package;
     * the duplication is intentional and tiny.
     */
    Credentials({
      id: "rpi-native",
      name: "RPI Native",
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        // signIn() always passes credentials as a plain object; type-guard
        // before forwarding to fetch.
        const username = credentials?.username;
        const password = credentials?.password;
        if (typeof username !== "string" || typeof password !== "string") return null;

        const tokenUrl = rpiTokenEndpoint();
        const clientId = process.env.RPI_OAUTH_CLIENT_ID;
        const clientSecret = process.env.RPI_OAUTH_CLIENT_SECRET;
        // Refuse to attempt login if the deployment is misconfigured — fail
        // loud in the server log, return null so the modal shows a clean
        // "Login failed" error rather than throwing.
        if (!tokenUrl || !clientId || !clientSecret) {
          console.error("[auth.rpi-native] RPI OAuth env not configured");
          return null;
        }

        try {
          const res = await fetch(tokenUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "password",
              username,
              password,
              client_id: clientId,
              client_secret: clientSecret,
            }),
          });
          if (!res.ok) {
            // Auth.js swallows the cause and reports "CredentialsSignin" to
            // the caller; log RPI's own error body server-side so we can
            // tell typo from misconfig (e.g. invalid_grant vs invalid_client).
            // Strip newlines so the diagnostic stays on one log line — RPI
            // returns pretty-printed JSON which otherwise truncates at the
            // first \n in the dev-server output.
            const body = (await res.text().catch(() => "<unreadable>"))
              .replace(/\s+/g, " ")
              .slice(0, 300);
            console.error(
              `[auth.rpi-native] /connect/token rejected: ${res.status} ${res.statusText} — ${body}`,
            );
            return null;
          }
          const data = (await res.json()) as RpiTokenResponse;
          // The returned shape is the User contract NextAuth passes to the
          // `jwt` callback as the `user` argument on first sign-in.
          // `id` and `name` are required-by-convention; `rpi*` are our
          // extensions (declared in apps/web/types/next-auth.d.ts).
          return {
            id: username,
            name: username,
            rpiAccessToken: data.access_token,
            rpiRefreshToken: data.refresh_token,
            rpiExpiresAt: Date.now() + data.expires_in * 1000,
          };
        } catch (err) {
          console.error("[auth.rpi-native] login failed:", err);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    /**
     * Called whenever a JWT is created (sign-in) or accessed (every request
     * that reads the session). Returned token is what gets encrypted into
     * the session cookie.
     *
     * Runs:
     *   - On sign-in: `user` is set; copy app-specific fields into the JWT.
     *   - On every other request: `user` is undefined; do lazy refresh if the
     *     RPI access token is near expiry.
     */
    async jwt({ token, user }) {
      // NextAuth v5's interface-augmentation chain (`next-auth` →
      // `@auth/core/jwt`) doesn't reliably propagate to consumers in this
      // setup, so we treat the JWT shape as a typed dictionary at the
      // read/write boundary and narrow with explicit guards. Once augmentation
      // works through the v5 re-export chain (or we drop to v4-style typing),
      // these casts can come out.
      const t = token as Record<string, unknown>;
      const u = user as Record<string, unknown> | undefined;

      // === Sign-in branch — copy User fields into the JWT === ----------------
      // For the API-key Credentials provider:
      if (typeof u?.apiKey === "string") t.apiKey = u.apiKey;
      // For the rpi-native Credentials provider:
      if (typeof u?.rpiAccessToken === "string") {
        t.rpiUsername = typeof u.name === "string" ? u.name : undefined;
        t.rpiAccessToken = u.rpiAccessToken;
        t.rpiRefreshToken = u.rpiRefreshToken;
        t.rpiExpiresAt = u.rpiExpiresAt;
      }

      // === Per-request branch — lazy refresh of RPI token ===----------------
      // Pre-emptive refresh: if the access token is within
      // RPI_REFRESH_MARGIN_MS of expiry AND we have a refresh_token, swap
      // for a fresh access_token BEFORE any downstream consumer (chat, MCP
      // forwarding) reads the session. This mirrors the getProxyToken()
      // pattern in packages/mcp-rpi/src/client/rpi-auth.ts:82–86.
      //
      // Reactive refresh (retry-on-401 from the MCP/RPI layer) is deferred to
      // a future hardening pass.
      const accessToken = t.rpiAccessToken;
      const refreshToken = t.rpiRefreshToken;
      const expiresAt = t.rpiExpiresAt;
      if (
        typeof accessToken === "string" &&
        typeof refreshToken === "string" &&
        typeof expiresAt === "number" &&
        Date.now() > expiresAt - RPI_REFRESH_MARGIN_MS
      ) {
        const tokenUrl = rpiTokenEndpoint();
        const clientId = process.env.RPI_OAUTH_CLIENT_ID;
        const clientSecret = process.env.RPI_OAUTH_CLIENT_SECRET;
        if (tokenUrl && clientId && clientSecret) {
          try {
            const res = await fetch(tokenUrl, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken,
                client_id: clientId,
                client_secret: clientSecret,
              }),
            });
            if (res.ok) {
              const data = (await res.json()) as RpiTokenResponse;
              t.rpiAccessToken = data.access_token;
              t.rpiRefreshToken = data.refresh_token ?? refreshToken;
              t.rpiExpiresAt = Date.now() + data.expires_in * 1000;
            } else {
              // Same diagnostic-logging pattern as authorize() — surface
              // RPI's reason for refusing the refresh (revoked, expired,
              // client mismatch) before silently dropping the session.
              const body = await res.text().catch(() => "<unreadable>");
              console.error(
                `[auth.jwt] /connect/token refresh rejected: ${res.status} ${res.statusText} — ${body.slice(0, 200)}`,
              );
              // Refresh rejected — drop the RPI session, keep the app session.
              t.rpiAccessToken = undefined;
              t.rpiRefreshToken = undefined;
              t.rpiExpiresAt = undefined;
              t.rpiUsername = undefined;
            }
          } catch (err) {
            console.error("[auth.jwt] refresh failed:", err);
          }
        }
      }

      return token;
    },
    /**
     * Called whenever the session is read (server side via `auth()`, or
     * client side via `useSession()`). The returned object is what the
     * caller actually sees. We use this to selectively expose JWT fields
     * — anything NOT spread into the session here is invisible to JS.
     */
    async session({ session, token }) {
      // Same-pattern boundary cast as the jwt callback: session has a strict
      // intersection type that doesn't accept dynamic field assignment, but
      // module augmentation (in types/next-auth.d.ts) tells downstream
      // consumers (e.g. useSession()) what fields are present. Cast through
      // `unknown` so TS allows the writes.
      const t = token as Record<string, unknown>;
      const s = session as unknown as Record<string, unknown>;

      // App identity — apiKey is exposed for the chat-panel headers callback
      // to attach as a Bearer to apps/server. Same threat surface as the
      // pre-PR behavior; tightening this is a separate hardening pass.
      if (typeof t.apiKey === "string") s.apiKey = t.apiKey;

      // RPI identity — only the USERNAME is exposed to JS, for UI display
      // ("Logged in to RPI as <username>"). The access_token deliberately
      // stays in the JWT only; the chat / runtime-status proxy route
      // handlers in apps/web/app/api/proxy/* read the rotated cookie
      // server-side via @auth/core's Auth(), decode the JWT, and attach the
      // Bearer to upstream apps/server requests. Browser code never sees
      // the raw token — closes the XSS exfil surface flagged in cousin's
      // PR 1 review.
      if (typeof t.rpiUsername === "string") {
        s.rpi = { username: t.rpiUsername };
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    // JWT strategy keeps the session entirely in the cookie — no DB session
    // table needed. AUTH_SECRET (verified at apps/server boot in
    // apps/server/src/index.ts:31–34) is the encryption key.
    strategy: "jwt",
  },
});
