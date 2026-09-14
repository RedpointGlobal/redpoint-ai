import { NextResponse } from "next/server";

/**
 * Runtime auth-mode signal for client components (the RPI header affordance
 * gates on it). A route handler runs per-request ON THE SERVER, so it reads the
 * live `process.env.AUTH_REQUIRED` — reflecting a `.env` flip after a restart,
 * with NO rebuild. This is deliberately NOT the build-time-inlined client value
 * (`next.config.ts` `env: { AUTH_REQUIRED }`), which would go stale if the flag
 * were flipped without rebuilding the web bundle.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    authRequired: process.env.AUTH_REQUIRED !== "false",
  });
}
