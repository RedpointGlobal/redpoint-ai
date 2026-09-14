import { NextResponse } from "next/server";
import { rpiLocationConfig } from "@/lib/rpi-location";

/**
 * Phase 1b — runtime signal for the login page's "Environment Location" field.
 * force-dynamic so it reads live env (RPI_URL_ALLOWLIST / RPI_INTEGRATION_API_URL)
 * per request. Returns { enabled, placeholder, urlAllowed } — never the allowlist
 * contents. Pass `?url=` to probe whether a specific location is permitted (for
 * the explicit "location not permitted" message).
 */
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const url = new URL(request.url).searchParams.get("url");
  return NextResponse.json(rpiLocationConfig(url));
}
