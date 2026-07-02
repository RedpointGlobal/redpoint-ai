import type { Skill } from "@redpoint-ai/skills";
import { isDispatchable } from "@redpoint-ai/skills";

/**
 * Tool-exposure tier — three-way degradation matching docs/architecture.md.
 *
 * - skill-router (best): single execute_skill meta-tool; sub-agents pick MCP tools at runtime
 * - category-discovery (mid): single tools_list meta-tool; LLM browses categories on-demand
 * - flat (worst, fallback): all discovered MCP tools exposed at once
 */
export type Tier = "skill-router" | "category-discovery" | "flat";

/** Minimal shape consumed by the resolver — keeps the helper test-friendly. */
export interface TierMcpInput {
  /** Did this connection's initialize handshake advertise listTools.supportsFiltering=true? */
  supportsFiltering: boolean;
}

/**
 * Resolve which tier the agent uses for a given workspace.
 *
 * Priority:
 *   1. Any actionable (action/hybrid) skill present → skill-router
 *   2. No actionable skills, but every connected MCP server supports filtering → category-discovery
 *   3. Otherwise → flat
 *
 * Multi-server note: if any single MCP connection lacks filtering, we drop to
 * flat. Mixed-capability category discovery (per-server tier) would require
 * a much fancier dispatcher and isn't worth the complexity until a real
 * multi-server workspace exists. Strict-AND keeps the LLM's mental model
 * uniform: "category discovery is on for everything, or it's off."
 */
export function resolveTier(
  skills: Skill[],
  mcpConnections: TierMcpInput[],
): Tier {
  const actionableSkills = skills.filter(isDispatchable);
  if (actionableSkills.length > 0) return "skill-router";

  if (
    mcpConnections.length > 0 &&
    mcpConnections.every((c) => c.supportsFiltering === true)
  ) {
    return "category-discovery";
  }

  return "flat";
}
