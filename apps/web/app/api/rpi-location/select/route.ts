import { NextResponse } from "next/server";
import {
  resolveEnvLocation,
  ENV_LOCATION_COOKIE,
  ENV_LOCATION_COOKIE_MAX_AGE,
} from "@/lib/env-location";

/**
 * POST /api/rpi-location/select — the SSO REDIRECT path's Environment Location
 * carrier. The login page calls this (with the selected URL) BEFORE
 * signIn("sso"), because the full-page OAuth redirect can't pass a
 * credential like the password paths. SSRF-validates the URL server-side, then:
 *   - rejected (non-allowlisted / non-https) → 400 (client shows the explicit
 *     "location not permitted" message; binary — no pre-flight access check).
 *   - a valid URL → set a FRESH, HttpOnly, SameSite=Lax, short-TTL cookie
 *     (overwrite; no accumulation).
 *   - blank → clear any stale carrier (blank = env default → backward-compat).
 * Reachable pre-auth (login page): `/api/rpi-location` is exempt from the gate.
 */
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let url: unknown;
  try {
    url = ((await request.json()) as { url?: unknown })?.url;
  } catch {
    url = undefined;
  }

  const loc = resolveEnvLocation(url);
  if (loc === null) {
    return NextResponse.json(
      { ok: false, error: "location-not-permitted" },
      { status: 400 },
    );
  }

  const res = NextResponse.json({ ok: true });
  if (typeof loc === "string") {
    res.cookies.set(ENV_LOCATION_COOKIE, loc, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.url.startsWith("https:"),
      path: "/",
      maxAge: ENV_LOCATION_COOKIE_MAX_AGE,
    });
  } else {
    // Blank → default instance; drop any stale carrier from a prior attempt.
    res.cookies.set(ENV_LOCATION_COOKIE, "", { path: "/", maxAge: 0 });
  }
  return res;
}
