import { describe, it, expect } from "bun:test";
import {
  WorkspaceCreateSchema,
  McpConnectionSchema,
  ProviderConfigSchema,
  AgentConfigSchema,
} from "../schemas/workspace.js";

// ---------------------------------------------------------------------------
// Minimal valid payloads used across tests
// ---------------------------------------------------------------------------

const validProvider = {
  type: "anthropic" as const,
  model: "claude-opus-4-5",
  apiKey: "sk-ant-test",
};

const minimalWorkspace = {
  name: "My Workspace",
  provider: validProvider,
};

// ---------------------------------------------------------------------------
// WorkspaceCreateSchema
// ---------------------------------------------------------------------------

describe("WorkspaceCreateSchema", () => {
  it("accepts a minimal valid workspace (name + provider only)", () => {
    const result = WorkspaceCreateSchema.safeParse(minimalWorkspace);
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated workspace", () => {
    const result = WorkspaceCreateSchema.safeParse({
      name: "Full Workspace",
      description: "A complete workspace configuration.",
      provider: validProvider,
      agent: {
        systemPrompt: "You are a helpful assistant.",
        maxSteps: 30,
      },
      mcp: [
        {
          name: "rpi-mcp",
          transport: "http",
          url: "https://mcp.example.com",
          allowedTools: ["audiences_list", "campaigns_get"],
        },
      ],
      skills: ["market-research", "send-email"],
      suggestions: ["What is my top campaign?", "Analyze audience overlap."],
    });
    expect(result.success).toBe(true);
  });

  it("fails when 'name' is missing", () => {
    const result = WorkspaceCreateSchema.safeParse({
      provider: validProvider,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("name");
    }
  });

  it("fails when 'name' is an empty string", () => {
    const result = WorkspaceCreateSchema.safeParse({
      ...minimalWorkspace,
      name: "",
    });
    expect(result.success).toBe(false);
  });

  it("fails when 'name' exceeds 255 characters", () => {
    const result = WorkspaceCreateSchema.safeParse({
      ...minimalWorkspace,
      name: "x".repeat(256),
    });
    expect(result.success).toBe(false);
  });

  it("accepts a name that is exactly 255 characters", () => {
    const result = WorkspaceCreateSchema.safeParse({
      ...minimalWorkspace,
      name: "a".repeat(255),
    });
    expect(result.success).toBe(true);
  });

  it("fails when 'provider' is missing", () => {
    const result = WorkspaceCreateSchema.safeParse({ name: "No Provider" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toContain("provider");
    }
  });

  it("fails when provider 'type' is an invalid enum value", () => {
    const result = WorkspaceCreateSchema.safeParse({
      ...minimalWorkspace,
      provider: { type: "grok", model: "grok-1" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("type"),
      );
      expect(issue).toBeDefined();
    }
  });

  it("accepts all valid provider types", () => {
    const validTypes = [
      "openai",
      "anthropic",
      "google",
      "ollama",
      "azure-openai",
    ] as const;

    for (const type of validTypes) {
      const result = WorkspaceCreateSchema.safeParse({
        name: `${type} workspace`,
        provider: { type, model: "some-model" },
      });
      expect(result.success).toBe(true);
    }
  });

  it("applies agent.maxSteps default of 20 when agent is provided without maxSteps", () => {
    const result = WorkspaceCreateSchema.safeParse({
      ...minimalWorkspace,
      agent: { systemPrompt: "Custom prompt." },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agent?.maxSteps).toBe(20);
    }
  });

  it("fails when agent.maxSteps exceeds 100", () => {
    const result = WorkspaceCreateSchema.safeParse({
      ...minimalWorkspace,
      agent: { maxSteps: 101 },
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// McpConnectionSchema
// ---------------------------------------------------------------------------

describe("McpConnectionSchema", () => {
  it("validates a minimal HTTP transport connection", () => {
    const result = McpConnectionSchema.safeParse({
      name: "my-mcp",
      transport: "http",
      url: "https://mcp.example.com/api",
    });
    expect(result.success).toBe(true);
  });

  it("validates a stdio transport connection with command and args", () => {
    const result = McpConnectionSchema.safeParse({
      name: "local-mcp",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      env: { NODE_ENV: "production" },
    });
    expect(result.success).toBe(true);
  });

  it("validates a connection with allowedTools filter", () => {
    const result = McpConnectionSchema.safeParse({
      name: "filtered-mcp",
      transport: "http",
      url: "https://mcp.example.com",
      allowedTools: ["tool_a", "tool_b"],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowedTools).toEqual(["tool_a", "tool_b"]);
    }
  });

  it("fails when 'transport' is an invalid value", () => {
    const result = McpConnectionSchema.safeParse({
      name: "bad-transport",
      transport: "websocket",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) =>
        i.path.includes("transport"),
      );
      expect(issue).toBeDefined();
    }
  });

  it("fails when 'name' is missing", () => {
    const result = McpConnectionSchema.safeParse({
      transport: "http",
      url: "https://mcp.example.com",
    });
    expect(result.success).toBe(false);
  });

  it("fails when 'transport' is missing", () => {
    const result = McpConnectionSchema.safeParse({
      name: "missing-transport",
    });
    expect(result.success).toBe(false);
  });

  it("accepts both 'http' and 'stdio' as valid transport values", () => {
    for (const transport of ["http", "stdio"] as const) {
      const result = McpConnectionSchema.safeParse({
        name: "test",
        transport,
      });
      expect(result.success).toBe(true);
    }
  });

  it("optional fields (url, command, args, env, allowedTools) are absent when not provided", () => {
    const result = McpConnectionSchema.safeParse({
      name: "minimal",
      transport: "stdio",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.url).toBeUndefined();
      expect(result.data.command).toBeUndefined();
      expect(result.data.args).toBeUndefined();
      expect(result.data.env).toBeUndefined();
      expect(result.data.allowedTools).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// ProviderConfigSchema (supplementary)
// ---------------------------------------------------------------------------

describe("ProviderConfigSchema", () => {
  it("requires both type and model", () => {
    expect(ProviderConfigSchema.safeParse({ type: "openai" }).success).toBe(
      false,
    );
    expect(
      ProviderConfigSchema.safeParse({ model: "gpt-4o" }).success,
    ).toBe(false);
  });

  it("accepts optional apiKey and baseUrl", () => {
    const result = ProviderConfigSchema.safeParse({
      type: "ollama",
      model: "llama3",
      baseUrl: "http://localhost:11434",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.baseUrl).toBe("http://localhost:11434");
      expect(result.data.apiKey).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// AgentConfigSchema (supplementary)
// ---------------------------------------------------------------------------

describe("AgentConfigSchema", () => {
  it("applies defaults for both fields when none are provided", () => {
    const result = AgentConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.systemPrompt).toBe("You are a helpful assistant.");
      expect(result.data.maxSteps).toBe(20);
    }
  });

  it("rejects maxSteps below 1", () => {
    const result = AgentConfigSchema.safeParse({ maxSteps: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects maxSteps above 100", () => {
    const result = AgentConfigSchema.safeParse({ maxSteps: 101 });
    expect(result.success).toBe(false);
  });

  it("accepts maxSteps of exactly 1 and 100 (boundaries)", () => {
    expect(AgentConfigSchema.safeParse({ maxSteps: 1 }).success).toBe(true);
    expect(AgentConfigSchema.safeParse({ maxSteps: 100 }).success).toBe(true);
  });
});
