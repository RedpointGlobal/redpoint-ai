/**
 * The authenticated caller, for data scoping (B3/B4).
 *
 * The auth middleware sets `user`: an RPI user (`rpi:<stable guid>`), an OIDC
 * `sub`, an API key (acting AS its owner — middleware/auth.ts), or, with auth OFF
 * (dev mode, AUTH_REQUIRED=false), the single "dev-user". Data a caller creates
 * (threads, trace events) is theirs; another caller gets a 404 for it. Dev mode is
 * one local operator, so it sees everything, including unowned legacy rows.
 */
import type { Context } from "hono";

/** Auth is off (dev mode): one local operator. */
export const isDevMode = (): boolean => process.env.AUTH_REQUIRED === "false";

/** The caller's identity for ownership (never empty). */
export function callerId(c: Context): string {
  return c.get("user")?.id ?? "anonymous";
}
