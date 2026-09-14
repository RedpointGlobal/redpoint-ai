import { describe, it, expect, afterEach } from "bun:test";
import { fetchInstanceSpec } from "../spec-fetch";
import { compareVersion } from "../version-check";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(impl: () => Promise<Response> | Response) {
  globalThis.fetch = (() => Promise.resolve(impl())) as typeof fetch;
}

const SWAGGER = {
  info: { version: "7.8.0.0" },
  paths: {
    "/api/v2/audiences": {},
    "/api/v2/interactions": {},
  },
};

describe("fetchInstanceSpec — one fetch, two signals", () => {
  it("returns endpoints + version from a well-formed swagger", async () => {
    mockFetch(() => new Response(JSON.stringify(SWAGGER), { status: 200 }));
    const spec = await fetchInstanceSpec("https://rpi.example.com/");
    expect(spec.version).toBe("7.8.0.0");
    expect(spec.endpoints).not.toBeNull();
    expect(spec.endpoints!.size).toBe(2);
    // end-to-end: the version drives a clean "match" against built-against 7.8
    expect(compareVersion(spec.version)).toBe("match");
  });

  it("version is null when info.version is absent (mask still works)", async () => {
    mockFetch(() => new Response(JSON.stringify({ paths: SWAGGER.paths }), { status: 200 }));
    const spec = await fetchInstanceSpec("https://rpi.example.com");
    expect(spec.version).toBeNull();
    expect(spec.endpoints!.size).toBe(2);
    expect(compareVersion(spec.version)).toBe("unknown"); // fail-open
  });

  it("FAIL-OPEN: non-200 → both null", async () => {
    mockFetch(() => new Response("nope", { status: 503 }));
    const spec = await fetchInstanceSpec("https://rpi.example.com");
    expect(spec).toEqual({ endpoints: null, version: null });
  });

  it("FAIL-OPEN: thrown (unreachable/timeout) → both null, never throws", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
    const spec = await fetchInstanceSpec("https://rpi.example.com");
    expect(spec).toEqual({ endpoints: null, version: null });
  });

  it("FAIL-OPEN: unparseable body → both null", async () => {
    mockFetch(() => new Response("<html>not json</html>", { status: 200 }));
    const spec = await fetchInstanceSpec("https://rpi.example.com");
    expect(spec).toEqual({ endpoints: null, version: null });
  });

  it("endpoints null when paths empty, but version still read", async () => {
    mockFetch(() => new Response(JSON.stringify({ info: { version: "7.9.0.0" }, paths: {} }), { status: 200 }));
    const spec = await fetchInstanceSpec("https://rpi.example.com");
    expect(spec.endpoints).toBeNull();
    expect(spec.version).toBe("7.9.0.0");
    expect(compareVersion(spec.version)).toBe("mismatch");
  });
});
