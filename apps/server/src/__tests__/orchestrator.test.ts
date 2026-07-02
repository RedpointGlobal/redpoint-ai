/**
 * Orchestrator pinning tests — source-string assertions.
 *
 * Background: AI SDK v6's ToolLoopAgent reads `instructions`, not `system`.
 * Passing `system` is silently ignored — no TypeScript error because
 * CallSettings on the agent permits extra keys. The bug bit us once
 * (every chat ran without a system prompt; "what does RPI stand for?"
 * answered "Rensselaer Polytechnic Institute" despite an explicit RPI
 * system prompt). Fixed.
 *
 * Why source-string assertions instead of mock.module("ai", ...): bun's
 * test runner shares module cache across test files in a single run.
 * If another test file loads "ai" first (and most do, transitively),
 * a later mock.module() for "ai" is a no-op. Asserting on the source
 * file directly is the only approach that survives the full-suite run.
 *
 * Brittle-looking, pin-tight in practice: if anyone changes the literal
 * `instructions:` back to `system:`, the build-time assertion fires.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCHESTRATOR_PATH = join(__dirname, "../agents/orchestrator.ts");
const SOURCE = readFileSync(ORCHESTRATOR_PATH, "utf8");

describe("orchestrator (createWorkspaceAgent) — pin AI-SDK contract", () => {
  it("constructs ToolLoopAgent", () => {
    expect(SOURCE).toMatch(/new\s+ToolLoopAgent\s*\(/);
  });

  it("uses `instructions:` field (not `system:`) — AI SDK v6 contract", () => {
    // The previous bug: `system: config.systemPrompt` (silently ignored).
    // The fix: `instructions: config.systemPrompt`.
    expect(SOURCE).toMatch(/instructions:\s*config\.systemPrompt/);
    // And nowhere does it pass `system:` to the agent constructor block.
    // Match `system:` specifically as a TS object property — `system: ` —
    // which would only appear inside a settings-object literal here.
    const inAgentSettings = SOURCE
      .split("new ToolLoopAgent(")[1]
      ?.split("})")[0] ?? "";
    expect(inAgentSettings).not.toMatch(/\bsystem:/);
  });

  it("forwards stopWhen via stepCountIs(maxSteps ?? 20)", () => {
    expect(SOURCE).toMatch(/stopWhen:\s*stepCountIs\s*\(\s*config\.maxSteps\s*\?\?\s*20\s*\)/);
  });

  it("sets maxRetries: 0 (fail-fast on serverless cold-start timeouts)", () => {
    expect(SOURCE).toMatch(/maxRetries:\s*0/);
  });

  it("forwards tools via `tools: config.tools ?? {}`", () => {
    expect(SOURCE).toMatch(/tools:\s*config\.tools\s*\?\?\s*\{\s*\}/);
  });
});
