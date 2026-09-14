// Shared helpers imported by the GENERATED tool files (src/tools/generated/*.ts).
// Hand-written tool files keep their own inline copies; generated files import from
// here so the emit template stays tiny. Not itself generated — safe to edit.
import { z } from "zod";

export const clientIdSchema = z
  .string()
  .optional()
  .describe(
    "RPI tenant/client ID sent as X-ClientID. Overrides the server default for this call.",
  );

export const verboseSchema = z
  .boolean()
  .optional()
  .describe("Return full RPI records instead of the trimmed default response.");

/**
 * Per-request RPI target URL ("Environment Location") from the handler's `extra`.
 * The middleware sets `authInfo.targetUrl` (from a validated X-RPI-URL); the SDK's
 * AuthInfo type doesn't declare it, so read it through a narrow cast. Returns
 * undefined when no per-request location was set (genuine default path). Pass the
 * result as `RequestOptions.baseUrl` on every RPI client call so the whole request
 * targets the rep's instance, not the boot default.
 */
export function targetUrlOf(extra: unknown): string | undefined {
  const info = (extra as { authInfo?: { targetUrl?: unknown } } | undefined)
    ?.authInfo;
  return typeof info?.targetUrl === "string" ? info.targetUrl : undefined;
}

export function jsonContent(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function errorContent(message: string, error: unknown) {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text" as const, text: `${message}: ${detail}` }],
    isError: true as const,
  };
}

/** Read-only annotations — every generated tool is a GET (structural guarantee). */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
