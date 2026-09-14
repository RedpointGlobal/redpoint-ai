import { describe, it, expect, afterEach } from "bun:test";
import {
  resolveUserId,
  resolveIdempotencyKey,
  extractTokenCounts,
  IDEMPOTENCY_HEADER,
} from "../instrumentation/context.js";

describe("resolveUserId", () => {
  const savedEnvId = process.env.INSTRUMENTATION_USER_ID;
  afterEach(() => {
    if (savedEnvId === undefined) delete process.env.INSTRUMENTATION_USER_ID;
    else process.env.INSTRUMENTATION_USER_ID = savedEnvId;
  });

  it("returns the OIDC principal id (Entra sub) when authenticated via OIDC", () => {
    delete process.env.INSTRUMENTATION_USER_ID;
    expect(resolveUserId({ id: "entra-sub-123", type: "oidc" })).toBe(
      "entra-sub-123",
    );
  });

  it("returns the API-key record id when authenticated via API key", () => {
    delete process.env.INSTRUMENTATION_USER_ID;
    expect(resolveUserId({ id: "key-abc", type: "apikey" })).toBe("key-abc");
  });

  it("prefers the authenticated principal over INSTRUMENTATION_USER_ID", () => {
    process.env.INSTRUMENTATION_USER_ID = "env-id";
    expect(resolveUserId({ id: "entra-sub-123", type: "oidc" })).toBe(
      "entra-sub-123",
    );
  });

  it("uses INSTRUMENTATION_USER_ID for the dev placeholder (shared image)", () => {
    process.env.INSTRUMENTATION_USER_ID = "tester-alice";
    expect(resolveUserId({ id: "dev-user", type: "apikey" })).toBe(
      "tester-alice",
    );
  });

  it("falls back to an os:-prefixed OS user when no env id is set", () => {
    delete process.env.INSTRUMENTATION_USER_ID;
    const result = resolveUserId({ id: "dev-user", type: "apikey" });
    expect(result).not.toBe("dev-user");
    expect(result === "unknown" || result.startsWith("os:")).toBe(true);
  });

  it("falls back when no user is present at all", () => {
    delete process.env.INSTRUMENTATION_USER_ID;
    const result = resolveUserId(undefined);
    expect(result).not.toBe("");
    expect(result === "unknown" || result.startsWith("os:")).toBe(true);
  });
});

describe("resolveIdempotencyKey", () => {
  it("uses the client-supplied header when present", () => {
    expect(resolveIdempotencyKey("client-key-1", "run-1")).toBe("client-key-1");
  });

  it("trims surrounding whitespace on the header value", () => {
    expect(resolveIdempotencyKey("  client-key-1  ", "run-1")).toBe(
      "client-key-1",
    );
  });

  it("falls back to runId when the header is undefined", () => {
    expect(resolveIdempotencyKey(undefined, "run-1")).toBe("run-1");
  });

  it("falls back to runId when the header is null", () => {
    expect(resolveIdempotencyKey(null, "run-1")).toBe("run-1");
  });

  it("falls back to runId when the header is blank", () => {
    expect(resolveIdempotencyKey("   ", "run-1")).toBe("run-1");
  });
});

describe("IDEMPOTENCY_HEADER", () => {
  it("is the X-Idempotency-Key header name", () => {
    expect(IDEMPOTENCY_HEADER).toBe("X-Idempotency-Key");
  });
});

describe("extractTokenCounts", () => {
  it("reads all six dimensions when present", () => {
    expect(
      extractTokenCounts({
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        inputTokenDetails: { cacheReadTokens: 10, cacheWriteTokens: 5 },
        outputTokenDetails: { reasoningTokens: 12 },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      reasoningTokens: 12,
      totalTokens: 140,
    });
  });

  it("defaults every dimension to 0 for an empty usage object", () => {
    expect(extractTokenCounts({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    });
  });

  it("falls back to input+output when totalTokens is absent", () => {
    expect(extractTokenCounts({ inputTokens: 30, outputTokens: 20 }).totalTokens).toBe(
      50,
    );
  });

  it("reads reasoningTokens from outputTokenDetails (not hardcoded 0)", () => {
    expect(
      extractTokenCounts({ outputTokenDetails: { reasoningTokens: 7 } })
        .reasoningTokens,
    ).toBe(7);
  });
});
