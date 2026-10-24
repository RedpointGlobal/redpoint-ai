/**
 * The standalone DRH MCP server binary's env contract — the keys its .env.example
 * carries, in code. Rendered into each binary zip by
 * scripts/copy-dist-templates.ts and checked by
 * `bun run check:binary-env` (and build:all) (no secret value, no real value in the rendered template).
 *
 * Service-credential mode: every call runs as one DRH service account (the proxy
 * user, signed on with Keycloak) — no per-user sign-in, as the binaries have always
 * run. The key set is every environment variable the server reads (a test checks it
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
  { key: "DRH_API_URL", comment: "Root URL of your Data Readiness Hub OP-ServicesAPI (no path suffix)", required: true, value: "https://drh.example.com" },
  { key: "DRH_DEFAULT_CLIENT_ID", comment: "The DRH tenant id, sent as the X-ClientId header on every call", required: true },
  { key: "DRH_PROXY_USER", comment: "The DRH account every call runs as (Keycloak sign-on)", required: true },
  { key: "DRH_PROXY_PASS", comment: "That account's password", required: true, secret: true },
  { key: "AUTH_REQUIRED", comment: "false = every call runs as the DRH account above (no per-user sign-in)", required: true, value: "false" },
  { key: "DRH_DEFAULT_DATABASE_ID", comment: "Optional: the database id used by database tools when a call names none", required: false },
  { key: "DRH_MCP_HTTP_PORT", comment: "Optional: the HTTP port (default 3003)", required: false },
  { key: "DRH_PROXY_ENABLED", comment: "Optional: false switches the DRH account off (default: on when user + password are set)", required: false },
  { key: "DRH_TOKEN_TTL_SECONDS", comment: "Optional: how long the account's sign-on token is reused when DRH doesn't say, in seconds (default 300)", required: false },
  { key: "DRH_CORS_ORIGINS", comment: "Optional: comma-separated web origins allowed to call the server (default http://localhost:3000,http://localhost:3001)", required: false },
  { key: "DRH_PIN_CLIENT_ID", comment: "Optional: true pins the server to DRH_DEFAULT_CLIENT_ID (one tenant); a per-call clientId that differs is refused. Compiled on in the hardened container.", required: false },
];

const SECRET_MARKER = "  (secret — leave empty here)";

/** The binary zip's .env.example, for the server version given. */
export function renderBinaryEnvTemplate(version: string): string {
  const header = `# DRH MCP Server ${version} — settings (generated from scripts/binary-env.ts)
# Copy this file to \`.env\` in the same folder as the binary, then fill in your values.
# Every call runs as the one DRH account below (no per-user sign-in).
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
