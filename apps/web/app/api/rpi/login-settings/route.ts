/**
 * GET /api/rpi/login-settings — proxy to RPI's
 * /api/v2/authentication/login-settings.
 *
 * Lives outside /api/auth/ on purpose: that prefix is owned by NextAuth's
 * catchall handler at /api/auth/[...nextauth]/route.ts which 400s any path
 * it doesn't recognize. Sibling /api/rpi/* is reserved for our own
 * RPI-passthrough handlers.
 *
 * Why a proxy instead of letting the browser call RPI directly:
 *   - RPI tenants don't enable CORS for browser clients.
 *   - We don't want RPI's URL in client JS — keep it server-side.
 *
 * The endpoint itself is unauthenticated on RPI's side (per
 * RPIAuthService.getLoginSettings() in packages/mcp-rpi/src/client/rpi-auth.ts).
 * The shape is `{ settings: LoginSetting[] }` or a bare array; we always
 * return the unwrapped array for the LoginModal to branch on.
 *
 * Used by `apps/web/components/auth/login-modal.tsx` to honor the
 * discovery contract — when the tenant returns any provider with
 * `isExternal: true`, the modal surfaces a notice (full IdP redirect UI is
 * deferred).
 */

import { NextResponse } from "next/server";

interface LoginSetting {
  authenticationType: string;
  isExternal: boolean;
  [key: string]: unknown;
}

// Strip an optional /api/v2 suffix — the login-settings endpoint expects to
// be appended onto the API root. Same regex as auth.ts's rpiTokenEndpoint().
function rpiBaseUrl(): string | null {
  const raw = process.env.RPI_INTEGRATION_API_URL;
  if (!raw) return null;
  return raw.replace(/\/api\/v2\/?$/, "").replace(/\/$/, "");
}

export async function GET(): Promise<Response> {
  const baseUrl = rpiBaseUrl();
  if (!baseUrl) {
    return NextResponse.json(
      { error: "RPI_INTEGRATION_API_URL not configured" },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(
      `${baseUrl}/api/v2/authentication/login-settings`,
    );
    if (!res.ok) {
      return NextResponse.json(
        { error: `RPI login-settings ${res.status} ${res.statusText}` },
        { status: 502 },
      );
    }
    const body = (await res.json()) as
      | LoginSetting[]
      | { settings: LoginSetting[] };
    const settings = Array.isArray(body) ? body : body.settings ?? [];
    return NextResponse.json({ settings });
  } catch (err) {
    return NextResponse.json(
      {
        error: `RPI login-settings fetch failed: ${err instanceof Error ? err.message : String(err)}`,
      },
      { status: 502 },
    );
  }
}
