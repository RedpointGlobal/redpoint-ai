/**
 * How every listener is served, pinned here in code (spread into the default export
 * and the [::1] listener in http.ts):
 *
 *   - development: false — PRODUCTION mode. Bun.serve's `development` defaults to true
 *     unless NODE_ENV=production; the images set it, the standalone executables carry
 *     no NODE_ENV at all, so the setting can't be left to the environment. In
 *     development mode an uncaught error in `fetch` is answered with Bun's error page,
 *     which embeds the error's message and stack; in production it is a bare 500.
 *     (Hono catches handler errors itself; this covers anything that escapes.)
 *   - reusePort: false — the port is this process's alone. Bun (seen on 1.3.12)
 *     sets SO_REUSEPORT on a listener without a hostname and on two listeners sharing
 *     a port, so a second instance on the same port started without error and the
 *     kernel split connections between the two — each with its own MCP sessions, so
 *     a client's requests landed on the wrong one ("Session not found"). Now the
 *     second instance fails to start: the port is in use.
 */
export const SERVE_MODE = { development: false, reusePort: false } as const;
