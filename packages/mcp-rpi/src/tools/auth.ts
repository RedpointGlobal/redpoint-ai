import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RPIApiClient } from "../client/rpi-api.js";
import type { RPIAuthService } from "../client/rpi-auth.js";
import type { OidcVerifier } from "../client/oidc-discovery.js";
import { createToolRegistrar } from "../tool-categories.js";
import { targetUrlOf, clientIdSchema } from "./generated-shared.js";

export function registerAuthTools(
  server: McpServer,
  rpiClient: RPIApiClient,
  authService: RPIAuthService,
  oidcVerifier?: OidcVerifier | null,
) {
  const registerTool = createToolRegistrar(server, "auth");

  registerTool(
    "verify_connection",
    {
      // NOTE (#27957 regen): _meta.endpoints is DUAL-USE — the runtime mask reads it
      // (server.ts), AND the tool generator's deriveHandEndpoints treats every listed
      // endpoint as HAND-COVERED (suppressing any overlay tool for it). verify_connection
      // only PROBES /authentication/user-client-list; the real LIST tool is the
      // overlay-generated get_user_client_list. Listing it here suppressed that tool, so
      // it is dropped from this mask stamp (kept in the probe body below). Residual quirk:
      // a hand probe whose _meta overlaps an overlay tool still suppresses it — generate:
      // tools:check catches recurrence (stale generated file); revisit only if it recurs.
      _meta: { endpoints: ["/info/version"] },
      title: "Verify RPI Connection",
      description:
        "THE connection/auth check — use this for any 'is my connection working?', " +
        "'am I connected?', 'is auth working?', 'check my RPI connection', or 'is my " +
        "token valid?' question. The connected/auth signal is the client-agnostic " +
        "user-client-list probe (200 for any authenticated user); /info/version is a " +
        "secondary version probe that needs a selected tenant. On a multi-tenant " +
        "instance with no tenant chosen yet, `connected` is still true and " +
        "`tenantSelected` is false — that is NOT an auth failure, so do NOT tell the " +
        "user to re-authenticate or contact an admin; tell them to pick a tenant. It is " +
        "low-privilege and per-user — it never 403s and needs no admin/cluster access, " +
        "so prefer it over the cluster error-log / audit tools for any connectivity or " +
        "sign-in question. (For 'show me recent errors' or 'what changed across the " +
        "cluster', those cluster-admin diagnostics tools are the right pick — not this.)",
      inputSchema: { clientId: clientIdSchema },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      const results: Record<string, unknown> = {};
      const userToken = extra.authInfo?.token;
      results.userTokenPresent = !!userToken;
      const activeClientId =
        typeof (_args as { clientId?: unknown })?.clientId === "string"
          ? (_args as { clientId?: string }).clientId
          : undefined;

      // OIDC detection status
      results.oidcEnabled = !!oidcVerifier;
      if (oidcVerifier) {
        results.oidcIssuer = oidcVerifier.config.issuer;
        results.oidcJwksUri = oidcVerifier.config.jwksUri;
        results.oidcAudience = oidcVerifier.config.audience ?? "(not set)";
      }

      // Check proxy token
      results.proxyEnabled = authService.proxyEnabled;
      if (authService.proxyEnabled) {
        try {
          await authService.getProxyToken();
          results.proxyTokenValid = true;
        } catch (error) {
          results.proxyTokenValid = false;
          results.proxyTokenError =
            error instanceof Error ? error.message : String(error);
        }
      }

      // Fetch login settings (no auth required)
      try {
        results.loginSettings = await authService.getLoginSettings();
      } catch (error) {
        results.loginSettingsError =
          error instanceof Error ? error.message : String(error);
      }

      // PRIMARY connectivity + auth probe. user-client-list is CLIENT-AGNOSTIC —
      // it needs only a valid token and returns 200 for ANY authenticated user, so
      // it is the true connected/auth signal even on a multi-tenant instance before
      // a tenant is chosen. (The old probe hit tenant-scoped /info/version with no
      // X-ClientID → a false 401 for reps who hadn't picked a tenant — #27895.)
      try {
        await rpiClient.get(userToken, "/authentication/user-client-list", undefined, {
          baseUrl: targetUrlOf(extra),
        });
        results.connected = true;
        results.apiCallSuccess = true; // back-compat alias for the connected signal
      } catch (error) {
        results.connected = false;
        results.apiCallSuccess = false;
        results.connectionError =
          error instanceof Error ? error.message : String(error);
      }

      // SECONDARY version probe — /info/version is TENANT-SCOPED (needs X-ClientID).
      // Run it only when connected, with the active client if one is set. A 401/403
      // here with no valid tenant is NOT a connection/auth failure — the user just
      // hasn't selected a tenant yet; report that softly (never "re-authenticate").
      if (results.connected) {
        try {
          results.version = await rpiClient.get(userToken, "/info/version", undefined, {
            clientId: activeClientId,
            baseUrl: targetUrlOf(extra),
          });
          results.tenantSelected = true;
        } catch {
          results.version = null;
          results.tenantSelected = false;
          results.tenantNote =
            "Connected and authenticated. No tenant selected yet — pick a tenant (client) to read tenant-scoped info such as version. This is not an authentication problem; do not re-authenticate.";
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(results, null, 2),
          },
        ],
      };
    },
  );
}
