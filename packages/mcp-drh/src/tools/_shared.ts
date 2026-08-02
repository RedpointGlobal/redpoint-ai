import { z } from "zod";

/**
 * Shared helpers for DRH tool files (databases, sources, feeds, …).
 *
 * Kept deliberately small: the per-tool `X-ClientId` arg, the MCP text content
 * envelopes, and the enum-consolidation helper (lifecycle actions like
 * pause/resume and enable/disable fold into a single boolean-arg tool that
 * dispatches to the right sub-path).
 */

/** Per-tool tenant arg. The DRHApiClient forwards it as the X-ClientId header;
 *  omit to use the server default (DRH_DEFAULT_CLIENT_ID). Distinct arg name so
 *  the platform's injected RPI clientId (stripped by zod) never bleeds in. */
export const drhClientIdSchema = z
  .string()
  .optional()
  .describe(
    "DRH client ID (tenant) for this call. Normally injected; omit to use the server default (DRH_DEFAULT_CLIENT_ID).",
  );

/** Numeric id path arg (databaseId, sourceId, feedId, run ids, …). */
export const numericIdSchema = (label: string) =>
  z.number().int().describe(label);

/** String id path arg (scheduleId, aggsScheduleId, jobId, automationId, …).
 *  Callers url-encode it into the path. */
export const stringIdSchema = (label: string) => z.string().describe(label);

/** Optional `databaseId` arg for database-scoped tools. Omit to use the tenant's
 *  database, resolved server-side (a Data Readiness Hub tenant has one). Never asked of the user. */
export const databaseIdArg = z
  .number()
  .int()
  .optional()
  .describe(
    "Database id (numeric). Omit to use the tenant's default database (resolved automatically; a Data Readiness Hub tenant has a single database).",
  );

/** Resolve the effective databaseId: the explicit arg if given, else the
 *  server-resolved default (override env or the tenant's single database).
 *  Throws (→ errorContent) if none can be determined. Structurally typed to
 *  avoid importing DRHApiClient here. */
export async function resolveDatabaseId(
  databaseId: number | undefined,
  client: { getDefaultDatabaseId(): Promise<number> },
): Promise<number> {
  return databaseId ?? (await client.getDefaultDatabaseId());
}

export function jsonContent(body: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
  };
}

export function errorContent(label: string, error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${label}: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}

/** Read-only tool annotations. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** Mutating (create/update) tool annotations. */
export const MUTATING = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

/** Destructive (delete) tool annotations. */
export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
} as const;
