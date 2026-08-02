// Build version — single source of truth. Both the apps/web Config tab and the
// server /health endpoint read this, so a running instance reports its real build
// version (a troubleshooting signal) rather than a hardcoded constant.
import versionData from "../version.json";
export const APP_VERSION: string = versionData.version;

/**
 * Canonical product-workspace names — the SINGLE source of truth.
 *
 * RedpointAI is the parent platform; the products are Redpoint Interaction
 * (RPI) and Data Readiness Hub (DRH). The seed creates workspaces under these
 * names and the integration suite resolves workspaces BY NAME, so a literal in
 * either place can silently desync from the other: when the seed was renamed,
 * `resolveWorkspaceIdByName("DR Hub")` started returning null and the whole DRH
 * routing gate skipped GREEN — testing nothing while looking healthy. Import
 * from here on both sides so a rename can never do that again.
 *
 * LEGACY_WORKSPACE_NAMES are the pre-rename values, kept only so the seed can
 * migrate an existing database in place.
 */
export const WORKSPACE_NAMES = {
  rpi: "Redpoint Interaction",
  drh: "Data Readiness Hub",
} as const;

export const LEGACY_WORKSPACE_NAMES = {
  rpi: "RedpointAI",
  drh: "DR Hub",
} as const;

// Schemas
export {
  WorkspaceSchema,
  WorkspaceCreateSchema,
  WorkspaceConfigSchema,
  McpConnectionSchema,
  ProviderConfigSchema,
  AgentConfigSchema,
} from "./schemas/workspace.js";

export { LLMProviderSchema } from "./schemas/provider.js";

export {
  MessageSchema,
  MessageRoleSchema,
  ThreadSchema,
  RunSchema,
  RunStatusSchema,
} from "./schemas/thread.js";

// Types
export type {
  Workspace,
  WorkspaceCreate,
  WorkspaceConfig,
  McpConnection,
  ProviderConfig,
  AgentConfig,
} from "./schemas/workspace.js";

export type { LLMProvider } from "./schemas/provider.js";

export type {
  Message,
  Thread,
  Run,
  RunStatus,
} from "./schemas/thread.js";

export type { TelemetryEvent } from "./types/telemetry.js";
