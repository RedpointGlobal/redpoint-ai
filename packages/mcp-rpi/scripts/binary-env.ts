/**
 * The standalone RPI MCP server binary's env contract — the keys its .env.example
 * carries, in code. Rendered into each binary zip by
 * scripts/copy-dist-templates.ts and checked by
 * `bun run check:binary-env` (and build:all) (no secret value, no real value in the rendered template).
 *
 * Service-credential mode: every call runs as one native RPI service account
 * (the proxy user) — no per-user sign-in, as the binaries have always run. The
 * key set is every environment variable the server reads (a test checks it
 * against src).
 */

export interface BinaryEnvKey {
  key: string;
  comment: string;
  /** Must be filled in for the server to work in service-credential mode. */
  required: boolean;
  /** A secret: always rendered empty, and its value may never appear in a committed template. */
  secret?: boolean;
  /** The value the template ships (default: empty). Never a real value. */
  value?: string;
}

export const BINARY_ENV_KEYS: readonly BinaryEnvKey[] = [
  { key: "RPI_INTEGRATION_API_URL", comment: "Root URL of your RPI Integration API (no /api/v2 suffix)", required: true, value: "https://rpi.example.com" },
  { key: "RPI_OAUTH_CLIENT_ID", comment: "The RPI OAuth client that grants the account's token (a confidential client)", required: true },
  { key: "RPI_OAUTH_CLIENT_SECRET", comment: "That client's secret", required: true, secret: true },
  { key: "RPI_PROXY_USER", comment: "The native RPI account every call runs as (not an SSO-only account)", required: true },
  { key: "RPI_PROXY_PASS", comment: "That account's password", required: true, secret: true },
  {
    key: "RPI_DEFAULT_CLIENT_ID",
    comment: "The RPI tenant (client) id calls run in — required in practice: without it only the login, version and cluster tools work",
    required: true,
  },
  { key: "AUTH_REQUIRED", comment: "false = every call runs as the RPI account above (no per-user sign-in); the server then answers this machine only (127.0.0.1)", required: true, value: "false" },
  { key: "RPI_MCP_HTTP_PORT", comment: "Optional: the HTTP port (default 3002)", required: false },
  { key: "RPI_PROXY_ENABLED", comment: "Optional: false switches the RPI account off (default: on when user + password are set)", required: false },
  { key: "RPI_URL_ALLOWLIST", comment: "Optional: comma-separated RPI hosts a client may target per request (X-RPI-URL); empty = the one above only", required: false },
  { key: "RPI_PIN_CLIENT_ID", comment: "Optional: true pins the server to RPI_DEFAULT_CLIENT_ID — a call naming another tenant is refused", required: false },
  { key: "RPI_MCP_PUBLIC_URL", comment: "Optional: this server's externally reachable origin, when it differs from the request's", required: false },
];

const SECRET_MARKER = "  (secret — leave empty here)";

/** The binary zip's .env.example, for the server version given. */
export function renderBinaryEnvTemplate(version: string): string {
  const header = `# RPI MCP Server ${version} — settings (generated from scripts/binary-env.ts)
# Copy this file to \`.env\` in the same folder as the binary, then fill in your values.
# Every call runs as the one RPI account below (no per-user sign-in).
`;
  const required = BINARY_ENV_KEYS.filter((k) => k.required);
  const optional = BINARY_ENV_KEYS.filter((k) => !k.required);
  const line = (k: BinaryEnvKey) => `# ${k.comment}${k.secret ? SECRET_MARKER : ""}\n${k.key}=${k.secret ? "" : (k.value ?? "")}`;
  return `${header}
# --- Required ---
${required.map(line).join("\n\n")}

# --- Optional ---
${optional.map(line).join("\n\n")}
`;
}
