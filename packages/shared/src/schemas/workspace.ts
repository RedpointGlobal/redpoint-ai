import { z } from "zod";

/** Allowlisted binaries for MCP stdio transport */
const SAFE_MCP_COMMANDS = new Set([
  "node", "bun", "npx", "bunx", "python", "python3", "uvx", "docker",
]);

/** Shell metacharacters that indicate command injection */
const SHELL_METACHAR_RE = /[;|&$`\\<>(){}!#]/;

export const McpConnectionSchema = z.object({
  name: z.string(),
  transport: z.enum(["http", "stdio"]),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  allowedTools: z.array(z.string()).optional(),
}).superRefine((conn, ctx) => {
  if (conn.transport === "stdio" && conn.command) {
    const basename = conn.command.split("/").pop() ?? conn.command;
    if (!SAFE_MCP_COMMANDS.has(basename)) {
      const permitted = [...SAFE_MCP_COMMANDS].toString();
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP stdio command \"" + basename + "\" is not allowed. Permitted: " + permitted,
        path: ["command"],
      });
    }
    if (SHELL_METACHAR_RE.test(conn.command)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP stdio command contains shell metacharacters",
        path: ["command"],
      });
    }
    if (conn.args?.some((a) => SHELL_METACHAR_RE.test(a))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP stdio args contain shell metacharacters",
        path: ["args"],
      });
    }
  }
  if (conn.transport === "http" && conn.url) {
    try {
      new URL(conn.url);
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "MCP HTTP connection URL is not a valid URL",
        path: ["url"],
      });
    }
  }
});

export const ProviderConfigSchema = z.object({
  type: z.enum([
    "openai",
    "anthropic",
    "google",
    "ollama",
    "azure-openai",
  ]),
  model: z.string(),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  azureDeployment: z.string().optional(),
});

export const AgentConfigSchema = z.object({
  systemPrompt: z.string().default("You are a helpful assistant."),
  maxSteps: z.number().int().min(1).max(100).default(20),
});

export const WorkspaceCreateSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  provider: ProviderConfigSchema,
  agent: AgentConfigSchema.optional(),
  mcp: z.array(McpConnectionSchema).optional(),
  skills: z.array(z.string()).optional(),
  suggestions: z.array(z.string()).optional(),
});

export const WorkspaceSchema = WorkspaceCreateSchema.extend({
  id: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

/** Schema for the JSON config blob stored in the workspaces table */
export const WorkspaceConfigSchema = z.object({
  provider: ProviderConfigSchema,
  agent: AgentConfigSchema.optional(),
  mcp: z.array(McpConnectionSchema).optional(),
  skills: z.array(z.string()).optional(),
  suggestions: z.array(z.string()).optional(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;
export type WorkspaceCreate = z.infer<typeof WorkspaceCreateSchema>;
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type McpConnection = z.infer<typeof McpConnectionSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
