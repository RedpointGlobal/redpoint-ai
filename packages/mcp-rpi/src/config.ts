import { z } from "zod";

export const RPIConfigSchema = z
  .object({
    integrationApiUrl: z.string().url(),
    proxyEnabled: z.boolean(),
    proxyUser: z.string().min(1).optional(),
    proxyPass: z.string().min(1).optional(),
    oauthClientId: z.string().min(1),
    oauthClientSecret: z.string().min(1),
    defaultClientId: z.string().min(1),
    authRequired: z.boolean().default(true),
  })
  .refine(
    (c) => !c.proxyEnabled || (!!c.proxyUser && !!c.proxyPass),
    { message: "proxyUser and proxyPass are required when proxyEnabled is true" },
  );

export type RPIConfig = z.infer<typeof RPIConfigSchema>;

/**
 * Resolve proxy-enabled state from env:
 *   - RPI_PROXY_ENABLED=false → disabled (creds ignored)
 *   - RPI_PROXY_ENABLED=true  → enabled (requires creds, else error)
 *   - unset                   → enabled iff both RPI_PROXY_USER and RPI_PROXY_PASS are set
 */
export function resolveProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const hasCreds = !!env.RPI_PROXY_USER && !!env.RPI_PROXY_PASS;
  const flag = env.RPI_PROXY_ENABLED?.toLowerCase();

  if (flag === "false") return false;
  if (flag === "true") {
    if (!hasCreds) {
      throw new Error(
        "RPI_PROXY_ENABLED=true but RPI_PROXY_USER and/or RPI_PROXY_PASS are not set.",
      );
    }
    return true;
  }
  return hasCreds;
}
