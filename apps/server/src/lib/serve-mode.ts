/**
 * MIRROR of packages/mcp-rpi/src/serve-mode.ts (the RPI MCP server, in this repo) —
 * keep in sync; __tests__/limits-sync.test.ts holds it identical.
 *
 * How the app server is served, pinned in code (spread into index.ts's default
 * export): development: false — PRODUCTION mode whatever NODE_ENV says (the server
 * image sets none), so an error escaping Hono is a bare 500, never Bun's error page
 * with its message and stack; reusePort: false — the port is this process's alone,
 * so a second instance fails to start instead of splitting connections.
 */
export const SERVE_MODE = { development: false, reusePort: false } as const;
