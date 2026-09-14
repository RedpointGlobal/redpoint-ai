import { describe, it, expect } from "bun:test";
import { exclusionReason, isExcluded, EXPECTED_IN_SCOPE } from "../tools/exclusions.js";

describe("exclusion config", () => {
  it("cuts /jobs/results/* (dead-end job-id endpoints)", () => {
    expect(exclusionReason("/api/v2/client/jobs/results/selection-rule-count-results", "GetSelectionRuleCountResults")).toBe(
      "jobs-results",
    );
  });

  it("cuts modified-date / last-modified probes", () => {
    expect(isExcluded("/api/v2/client/files/audience/last-modified", "GetAudienceLastModified")).toBe(true);
    expect(exclusionReason("/api/v2/x/modified-date", "GetModifiedDate")).toBe("modified-date-probes");
  });

  it("cuts write-flow enums, help/example, QA/swagger, mercury/published-content", () => {
    expect(isExcluded("/api/v2/client/configuration/date-part-types", "GetDatePartTypes")).toBe(true);
    expect(isExcluded("/api/v2/client/help/topics", "GetHelp")).toBe(true);
    expect(isExcluded("/api/v2/qa/ping", "QaPing")).toBe(true);
    expect(isExcluded("/api/v2/client/mercury/status", "GetMercuryStatus")).toBe(true);
  });

  it("cuts the openid .well-known auth-plumbing route", () => {
    expect(exclusionReason("/swagger/.well-known/openid-configuration", "")).toBe("qa-swagger");
  });

  it("cuts action-shaped GETs (GET verb but mutate state) — cuz sweep #27634", () => {
    expect(exclusionReason("/api/v2/client/data-connector/activate", "ListSyncInfoActivate")).toBe(
      "action-shaped-gets",
    );
    expect(exclusionReason("/api/v2/client/data-connector/deactivate", "ListSyncInfoDeactivate")).toBe(
      "action-shaped-gets",
    );
    expect(
      exclusionReason("/api/v2/cluster/operations/maintenance/stop", "StopClusterOperationManagementMaintenance"),
    ).toBe("action-shaped-gets");
  });

  it("keeps verb-in-noun reads in scope (sync-info status, web-publish-site-map)", () => {
    // "GetListSyncInfo" reads connector sync STATUS; the verb "sync" is a noun here.
    expect(isExcluded("/api/v2/client/data-connectors", "GetListSyncInfo")).toBe(false);
    expect(isExcluded("/api/v2/client/configuration/web-publish-site-maps", "GetWebPublishSiteMaps")).toBe(false);
  });

  it("keeps a plain in-scope GET (e.g. an audience read)", () => {
    expect(isExcluded("/api/v2/client/files/audience", "GetAudience")).toBe(false);
    expect(exclusionReason("/api/v2/cluster/operations/clients", "GetClusterClients")).toBeNull();
  });

  it("pins the in-scope target so a spec rename can't silently un-cut", () => {
    expect(EXPECTED_IN_SCOPE).toBe(185);
  });
});
