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
  // Model/deployment overrides — saved and cleared too, so a value in the
  // developer's real .env can't leak in and make these assertions lie.
  "AZURE_OPENAI_DEPLOYMENT_ID",
  "AZURE_OPENAI_MODEL",
  "ANTHROPIC_MODEL",
  "OPENAI_MODEL",
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

  it("honours AZURE_OPENAI_DEPLOYMENT_ID for the deployment and model", () => {
    // The variable ships in .env, in the bundle .env and in docker-compose, but
    // nothing read it at runtime — an operator repointed it, restarted, and
    // nothing changed because the model lived in the workspace row. With the
    // settings UI gone the environment is the only way to choose a model.
    process.env.AZURE_OPENAI_API_KEY = "k";
    process.env.AZURE_OPENAI_DEPLOYMENT_ID = "gpt-5-custom";
    const p = pickDefaultProvider();
    expect(p.type).toBe("azure-openai");
    expect(p.azureDeployment).toBe("gpt-5-custom");
    expect(p.model).toBe("gpt-5-custom");
  });

  it("lets an explicit model override win over the deployment id", () => {
    process.env.AZURE_OPENAI_API_KEY = "k";
    process.env.AZURE_OPENAI_DEPLOYMENT_ID = "my-deployment";
    process.env.AZURE_OPENAI_MODEL = "gpt-4.1";
    const p = pickDefaultProvider();
    expect(p.azureDeployment).toBe("my-deployment");
    expect(p.model).toBe("gpt-4.1");
  });

  it("honours ANTHROPIC_MODEL and OPENAI_MODEL overrides", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.ANTHROPIC_MODEL = "claude-custom";
    expect(pickDefaultProvider().model).toBe("claude-custom");
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "k";
    process.env.OPENAI_MODEL = "gpt-custom";
    expect(pickDefaultProvider().model).toBe("gpt-custom");
  });

  it("falls back to the shipped defaults when no override is set", () => {
    process.env.AZURE_OPENAI_API_KEY = "k";
    const p = pickDefaultProvider();
    expect(p.model).toBe("gpt-4.1");
    expect(p.azureDeployment).toBe("gpt-4.1");
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
