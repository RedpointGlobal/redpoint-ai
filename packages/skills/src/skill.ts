import { z } from "zod";

export const SkillTypeSchema = z.enum(["action", "expert", "hybrid"]);
export type SkillType = z.infer<typeof SkillTypeSchema>;

export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  type: SkillTypeSchema.optional(),
  mcpToolFilter: z.array(z.string()).optional(),
  maxSteps: z.number().int().min(1).max(50).default(10),
  tags: z.array(z.string()).optional(),
  operations: z.record(z.string(), z.array(z.string())).optional(),
  /**
   * Dispatched-expert flag. An `expert` skill is inlined into the router prompt
   * by default; set `dispatch: true` to instead surface it as a tool-less catalog
   * entry reached via `execute_skill` — its (potentially large) knowledge body
   * loads into a sub-agent only on a knowledge-intent hit, costing the parent
   * prompt nothing. Absent/false = today's inline behavior.
   */
  dispatch: z.boolean().optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface Skill {
  /** Unique skill identifier */
  name: string;
  /** Display name */
  title: string;
  /** Short description for the catalog */
  description: string;
  /** Resolved type: action (tools only), expert (knowledge only), hybrid (both) */
  type: SkillType;
  /** System prompt / instructions (the markdown body) */
  instructions: string;
  /** MCP tool name patterns this skill can use (action/hybrid only) */
  mcpToolFilter?: string[];
  /** Max tool-loop steps for the sub-agent */
  maxSteps: number;
  /** Optional tags for categorization */
  tags?: string[];
  /**
   * Pattern A — operation-class dynamic tool filter. Maps operation names
   * (e.g. "list", "get", "workflow") to narrower tool subsets. When the
   * router picks an operation, the sub-agent gets that subset instead of
   * the full mcpToolFilter, shrinking the sub-agent prompt. Falls back to
   * mcpToolFilter on missing/unknown operation.
   */
  operations?: Record<string, string[]>;
  /**
   * Dispatched-expert flag. When true on a `type: expert` skill, it is
   * catalogued + reached via `execute_skill` (tool-less) instead of being
   * inlined into the router prompt. See `isDispatchable`/`isInlinedExpert`.
   */
  dispatch?: boolean;
}

/**
 * A skill is "dispatchable" — surfaced in the router catalog and reachable via
 * `execute_skill` — when it is NOT a plain inlined expert. Action and hybrid
 * skills always dispatch; an `expert` dispatches only when flagged
 * `dispatch: true` (a tool-less knowledge skill loaded into a sub-agent on
 * demand rather than inlined into the parent prompt).
 *
 * This is the single source of truth for the "actionable / needs execute_skill"
 * test — every call site (router catalog split, execute_skill registration in
 * chat/agui/a2a, tier resolution, workspace counts) routes through it so a
 * dispatched expert can never be silently excluded from the dispatch path.
 */
export function isDispatchable(
  skill: Pick<Skill, "type" | "dispatch">,
): boolean {
  return skill.type !== "expert" || skill.dispatch === true;
}

/**
 * The inverse of {@link isDispatchable} for the knowledge side: a plain expert
 * whose body is inlined into the router prompt (e.g. the cross-cutting
 * foundation expert). A `dispatch: true` expert is NOT inlined.
 */
export function isInlinedExpert(
  skill: Pick<Skill, "type" | "dispatch">,
): boolean {
  return skill.type === "expert" && skill.dispatch !== true;
}

/**
 * Infer skill type from config:
 * - Has mcpToolFilter and instructions -> hybrid
 * - Has mcpToolFilter, no substantial instructions -> action
 * - No mcpToolFilter -> expert
 */
export function inferSkillType(
  mcpToolFilter: string[] | undefined,
  instructions: string,
): SkillType {
  if (!mcpToolFilter || mcpToolFilter.length === 0) {
    return "expert";
  }
  // If instructions are substantial (more than a short prompt), it's hybrid
  const trimmed = instructions.trim();
  if (trimmed.length > 200) {
    return "hybrid";
  }
  return "action";
}
