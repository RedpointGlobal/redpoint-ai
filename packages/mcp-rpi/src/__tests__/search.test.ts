/**
 * Unit tests for the `searchFileInfos` helper. Validates that the wire body
 * matches RPI's `SearchWithTypesPagingFilterJsonRequestMessage` schema
 * (including the required `$jsonType` / `$jsonTypeID` discriminators).
 */
import { describe, it, expect, afterEach, mock } from "bun:test";
import {
  buildSearchFileInfosBody,
  searchFileInfos,
} from "../client/search.js";
import { RPIApiClient } from "../client/rpi-api.js";
import { RPIAuthService } from "../client/rpi-auth.js";

const originalFetch = globalThis.fetch;
function stubFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  globalThis.fetch = mock(handler as any) as any;
}
function restoreFetch() {
  globalThis.fetch = originalFetch;
}
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function buildClient(defaultClientId = "tenant-default") {
  const auth = new RPIAuthService(
    "https://rpi.example.com",
    "oauth-id",
    "oauth-secret",
    "proxy-user",
    "proxy-pass",
  );
  return new RPIApiClient("https://rpi.example.com", auth, defaultClientId);
}

describe("buildSearchFileInfosBody", () => {
  it("emits the required $jsonType and $jsonTypeID discriminators", () => {
    const body = buildSearchFileInfosBody({ fileTypes: ["Audience"] });
    expect(body.$jsonType).toBe("SearchWithTypesPagingFilterJsonRequestMessage");
    expect(body.$jsonTypeID).toBe("e55bff8b-a6ab-4e82-abb2-6d4b08f16917");
  });

  it("uses defaults: pageNumber=1, pageSize=10, searchString='*', templateFilter='NoFilter', resultsOrder='TypeAndName'", () => {
    const body = buildSearchFileInfosBody({});
    expect(body.pageNumber).toBe(1);
    expect(body.pageSize).toBe(10);
    expect(body.searchString).toBe("*");
    expect(body.templateFilter).toBe("NoFilter");
    expect(body.resultsOrder).toBe("TypeAndName");
  });

  it("passes fileTypeFilters through when provided", () => {
    const body = buildSearchFileInfosBody({
      fileTypes: ["Audience", "SelectionRule"],
    });
    expect(body.fileTypeFilters).toEqual(["Audience", "SelectionRule"]);
  });

  it("omits fileTypeFilters when not provided or empty", () => {
    expect(buildSearchFileInfosBody({}).fileTypeFilters).toBeUndefined();
    expect(
      buildSearchFileInfosBody({ fileTypes: [] }).fileTypeFilters,
    ).toBeUndefined();
  });

  it("passes subTypeFilters through when provided", () => {
    const body = buildSearchFileInfosBody({
      fileTypes: ["Audience"],
      subTypes: ["Standard"],
    });
    expect(body.subTypeFilters).toEqual(["Standard"]);
  });

  it("honors an explicit searchString overriding the '*' default", () => {
    const body = buildSearchFileInfosBody({ searchString: "acme" });
    expect(body.searchString).toBe("acme");
  });

  it("honors explicit pagination overriding defaults", () => {
    const body = buildSearchFileInfosBody({ pageNumber: 3, pageSize: 50 });
    expect(body.pageNumber).toBe(3);
    expect(body.pageSize).toBe(50);
  });

  it("honors explicit resultsOrder and templateFilter", () => {
    const body = buildSearchFileInfosBody({
      resultsOrder: "DateModified",
      templateFilter: "TemplatesOnly",
    });
    expect(body.resultsOrder).toBe("DateModified");
    expect(body.templateFilter).toBe("TemplatesOnly");
  });
});

describe("searchFileInfos", () => {
  afterEach(() => restoreFetch());

  it("calls POST /client/file-system/search-file-infos with the built body", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedBody = "";
    stubFetch(async (url, init) => {
      capturedUrl = url.toString();
      capturedMethod = init?.method ?? "";
      capturedBody = init?.body as string;
      return jsonResponse({ results: [] });
    });

    const client = buildClient();
    await searchFileInfos(client, "user-token", {
      fileTypes: ["Audience"],
      searchString: "holiday",
      pageNumber: 2,
      pageSize: 10,
    });

    expect(capturedMethod).toBe("POST");
    expect(capturedUrl).toBe(
      "https://rpi.example.com/api/v2/client/file-system/search-file-infos",
    );
    const parsed = JSON.parse(capturedBody);
    expect(parsed.fileTypeFilters).toEqual(["Audience"]);
    expect(parsed.searchString).toBe("holiday");
    expect(parsed.pageNumber).toBe(2);
    expect(parsed.pageSize).toBe(10);
    expect(parsed.$jsonType).toBe(
      "SearchWithTypesPagingFilterJsonRequestMessage",
    );
  });

  it("sets X-ClientID header from defaultClientId when no override is passed", async () => {
    let capturedHeaders: Record<string, string> = {};
    stubFetch(async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return jsonResponse({ results: [] });
    });

    const client = buildClient("tenant-default");
    await searchFileInfos(client, "user-token", { fileTypes: ["Audience"] });

    expect(capturedHeaders["X-ClientID"]).toBe("tenant-default");
  });

  it("sets X-ClientID header from per-call clientId override", async () => {
    let capturedHeaders: Record<string, string> = {};
    stubFetch(async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return jsonResponse({ results: [] });
    });

    const client = buildClient("tenant-default");
    await searchFileInfos(
      client,
      "user-token",
      { fileTypes: ["Audience"] },
      { clientId: "tenant-override" },
    );

    expect(capturedHeaders["X-ClientID"]).toBe("tenant-override");
  });
});
