/**
 * Local-only access, for a server that runs every call as ONE account with no
 * sign-in (mcp-rpi's env-credential mode: AUTH_REQUIRED=false with the proxy user
 * on). Whoever reaches such a server acts as that account, so it answers only
 * clients on this machine:
 *
 *   - the listener binds the loopback interface (no LAN; see http.ts);
 *   - a browser request is refused unless its page is on this machine: the Origin
 *     header, when present, must be http(s)://localhost | 127.0.0.1 | [::1] on any
 *     port. Native MCP clients send no Origin (measured: Claude Code, mcp-remote (and
 *     Claude Desktop through it), the MCP SDK under Node and Bun, curl). The literal
 *     "null" (a sandboxed iframe, a file:// page) and a malformed value are refused;
 *   - the Host header must name the loopback (any port), so a DNS-rebinding page
 *     (evil.example resolving to 127.0.0.1) is refused even without an Origin match.
 *
 * Refusals are 403 with a JSON reason. With a token (AUTH_REQUIRED on) the token is
 * the gate and none of this applies.
 */
import { createMiddleware } from "hono/factory";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** An Origin header value a local page sends (absent = a native client). */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null", malformed
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // An Origin is exactly scheme://host[:port], as a browser serializes it: anything
  // more (a path, userinfo, a trailing slash) is malformed.
  if (url.origin !== origin.toLowerCase()) return false;
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** A Host header's shape: a name, an IPv4 address or a bracketed IPv6 literal, then an optional port. */
const HOST_SHAPE = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/;

/**
 * A Host header value naming this machine's loopback, any port. The hostname is
 * compared normalized: .NET sends the IPv6 loopback expanded
 * ([0000:0000:0000:0000:0000:0000:0000:0001]:3002, measured), which is [::1].
 */
export function hostAllowed(host: string | undefined): boolean {
  if (!host || !HOST_SHAPE.test(host)) return false; // userinfo, a path, junk
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** Refuse (403) any request that isn't from a client on this machine. */
export function localOnly() {
  return createMiddleware(async (c, next) => {
    if (!hostAllowed(c.req.header("host"))) {
      return c.json({ error: "Refused: this server answers only on this machine (the Host must be localhost)." }, 403);
    }
    if (!originAllowed(c.req.header("origin"))) {
      return c.json(
        { error: "Refused: a web page from another site may not call this server (it runs as one RPI account, for clients on this machine only)." },
        403,
      );
    }
    await next();
  });
}
