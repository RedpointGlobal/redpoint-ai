/**
 * Integration test: chained tool flow for interactions.
 *
 * Picks an interaction from list_interactions, then exercises get_by_id,
 * get_by_name, and the workflows sub-resource. Where possible, drills into
 * workflow_activities and trigger for the first workflow association.
 *
 * Skips entirely when env vars are missing. Within each step, gracefully
 * skips the remainder when the RPI instance has no relevant data.
 */
import { describe, it, expect, beforeAll } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { RPIAuthService } from "../../client/rpi-auth.js";
import { RPIApiClient } from "../../client/rpi-api.js";
import { searchFileInfos } from "../../client/search.js";
import { findByNameExact } from "../../tools/audiences.js";

// ---------------------------------------------------------------------------
// Root .env loader
// ---------------------------------------------------------------------------

const __testsDir = dirname(fileURLToPath(import.meta.url));
const rootEnv = join(__testsDir, "../../../../../.env");
if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const commentIdx = value.indexOf("#");
      if (commentIdx > 0) value = value.slice(0, commentIdx).trim();
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const REQUIRED = [
  "RPI_INTEGRATION_API_URL",
  "RPI_OAUTH_CLIENT_ID",
  "RPI_OAUTH_CLIENT_SECRET",
  "RPI_DEFAULT_CLIENT_ID",
  "RPI_PROXY_USER",
  "RPI_PROXY_PASS",
] as const;

const missing = REQUIRED.filter((k) => !process.env[k]);
const shouldSkip = missing.length > 0;

if (shouldSkip) {
  console.error(
    `[integration] Skipping interactions tool chain — missing env: ${missing.join(", ")}`,
  );
}

describe.skipIf(shouldSkip)("Interactions tool chain (live)", () => {
  let apiClient: RPIApiClient;
  let proxyToken: string;

  beforeAll(async () => {
    const authService = new RPIAuthService(
      process.env.RPI_INTEGRATION_API_URL!,
      process.env.RPI_OAUTH_CLIENT_ID!,
      process.env.RPI_OAUTH_CLIENT_SECRET!,
      process.env.RPI_PROXY_USER,
      process.env.RPI_PROXY_PASS,
    );
    apiClient = new RPIApiClient(
      process.env.RPI_INTEGRATION_API_URL!,
      authService,
      process.env.RPI_DEFAULT_CLIENT_ID!,
    );
    proxyToken = await authService.getProxyToken();
  });

  it("chained interactions flow: list → get_by_id → get_by_name → workflows", async () => {
    // 1. List interactions
    const listResult = await searchFileInfos<{
      results?: Array<{ id?: string | null; name?: string | null }>;
    }>(apiClient, proxyToken, {
      fileTypes: ["Interaction"],
      pageSize: 5,
    });
    const list = listResult?.results ?? [];

    if (list.length === 0) {
      console.error(
        "[integration] No interactions in this RPI instance — skipping chained assertions.",
      );
      return;
    }

    const picked = list.find(
      (x) => x && x.id && x.id.length > 0 && x.name && x.name.length > 0,
    );
    if (!picked) {
      console.error(
        "[integration] list_interactions returned items but none had both id and name — skipping.",
      );
      return;
    }
    console.error(
      `[integration] Chained interactions flow picked: id=${picked.id}, name=${picked.name}`,
    );

    // 2. get_interaction_by_id — just verify it returns an object
    const byId = await apiClient.get<Record<string, unknown>>(
      proxyToken,
      "/client/files/interaction",
      { ID: picked.id! },
    );
    expect(byId).toBeDefined();
    expect(typeof byId).toBe("object");

    // 3. get_interaction_by_name (exact CI match via search)
    const searchByName = await searchFileInfos<{
      results?: Array<{ id?: string | null; name?: string | null }>;
    }>(apiClient, proxyToken, {
      fileTypes: ["Interaction"],
      searchString: picked.name!,
      pageSize: 255,
    });
    const nameMatch = findByNameExact(
      searchByName?.results ?? [],
      picked.name!,
    );
    expect(nameMatch).toBeDefined();
    expect((nameMatch?.id ?? "").toLowerCase()).toBe(picked.id!.toLowerCase());

    // 4. get_interaction_workflows
    const workflowsResult = await apiClient.get<Record<string, unknown>>(
      proxyToken,
      "/client/files/interaction/workflows",
      { ID: picked.id! },
    );
    expect(workflowsResult).toBeDefined();
    console.error(
      `[integration] get_interaction_workflows returned shape: ${JSON.stringify(Object.keys(workflowsResult ?? {}))}`,
    );
  });

  it("drills into the first workflow association when one exists", async () => {
    // Pick an interaction
    const listResult = await searchFileInfos<{
      results?: Array<{ id?: string | null; name?: string | null }>;
    }>(apiClient, proxyToken, {
      fileTypes: ["Interaction"],
      pageSize: 10,
    });
    const list = listResult?.results ?? [];
    if (list.length === 0) {
      console.error(
        "[integration] No interactions — skipping workflow-drill test.",
      );
      return;
    }
    const picked = list.find((x) => x?.id && x?.name);
    if (!picked) return;

    // Get workflows for that interaction
    const workflows = await apiClient.get<{
      workflowAssociations?: Array<{
        id?: string | null;
        workflowID?: string | null;
      }>;
    } & Record<string, unknown>>(
      proxyToken,
      "/client/files/interaction/workflows",
      { ID: picked.id! },
    );

    // Try a few common field names the RPI response may use
    const associations =
      (workflows?.workflowAssociations as Array<{
        id?: string;
        workflowAssociationID?: string;
      }>) ??
      ((workflows as { associations?: Array<{ id?: string }> })?.associations) ??
      [];

    if (!Array.isArray(associations) || associations.length === 0) {
      console.error(
        `[integration] Interaction "${picked.name}" has no workflow associations — skipping drill.`,
      );
      return;
    }

    const association = associations[0] as {
      id?: string;
      workflowAssociationID?: string;
    };
    const associationId = association.id ?? association.workflowAssociationID;
    if (!associationId) {
      console.error(
        "[integration] First workflow association had no id — skipping drill.",
      );
      return;
    }
    console.error(
      `[integration] Drilling into workflow association: ${associationId}`,
    );

    // get_interaction_workflow_activities
    const activities = await apiClient.get<Record<string, unknown>>(
      proxyToken,
      "/client/files/interaction/workflow/activities",
      {
        InteractionID: picked.id!,
        WorkflowAssociationID: associationId,
      },
    );
    expect(activities).toBeDefined();
    expect(typeof activities).toBe("object");
  });
});
