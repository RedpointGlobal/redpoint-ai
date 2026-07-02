/**
 * Unit tests for pickDefaultProvider() — the key-presence-adaptive seed
 * provider selector (provider-seed audit fix).
 *
 * Strategy: mock the `db` singleton to a no-op BEFORE importing seed.ts so
 * this stays a pure unit test of the selector with no filesystem DB. Mirrors
 * the mock.module() pattern in workspaces.test.ts; safe under `bun run test`
 * (per-package process isolation — see root CLAUDE.md test-invocation note).
 */
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";

mock.module("../store/db.js", () => ({ db: {}, default: {} }));

const { pickDefaultProvider } = await import("../store/seed.js");

const KEYS = [
  "AZURE_OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

describe("pickDefaultProvider — key-presence-adaptive seed (audit #6)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("picks azure-openai when AZURE_OPENAI_API_KEY is set", () => {
    process.env.AZURE_OPENAI_API_KEY = "azk";
    expect(pickDefaultProvider()).toEqual({
      type: "azure-openai",
      model: "gpt-4.1",
      azureDeployment: "gpt-4.1",
    });
  });

  it("picks anthropic when only ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-real";
    expect(pickDefaultProvider()).toEqual({
      type: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("picks openai when only OPENAI_API_KEY is set", () => {
    process.env.OPENAI_API_KEY = "sk-real";
    expect(pickDefaultProvider()).toEqual({
      type: "openai",
      model: "gpt-4o",
    });
  });

  it("Azure wins when multiple keys are set (existing-install precedence, zero regression)", () => {
    process.env.AZURE_OPENAI_API_KEY = "azk";
    process.env.ANTHROPIC_API_KEY = "sk-ant-real";
    process.env.OPENAI_API_KEY = "sk-real";
    expect(pickDefaultProvider().type).toBe("azure-openai");
  });

  it("falls back to azure-openai when no key is set (seed must not hard-fail)", () => {
    expect(pickDefaultProvider()).toEqual({
      type: "azure-openai",
      model: "gpt-4.1",
      azureDeployment: "gpt-4.1",
    });
  });
});
