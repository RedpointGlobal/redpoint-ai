# Skills

Skills are the routing and orchestration layer that groups MCP tools into domain-specific bundles for token-efficient agent execution.

## Skill Types

| Type | Purpose | Has Tools? | Sub-agent Behavior |
|------|---------|------------|-------------------|
| **action** | Execute operations against RPI | Yes (MCP tools) | Calls MCP tools, returns structured results |
| **expert** | Domain knowledge oracle | No | Answers from rich context, no tool calls |
| **hybrid** | Knowledge + tools | Yes (MCP tools) | Consults domain knowledge, then optionally calls tools |

## SKILL.md Format

Each skill is a directory containing a `SKILL.md` file with YAML frontmatter and a markdown body:

```markdown
---
name: rpi-audiences
title: RPI Audiences
description: Action skill for audience operations
type: action
mcpToolFilter:
  - list_audiences
  - get_audience_by_name
  - get_audience_metadata
  - list_audience_definitions
  - run_audience_test_workflow
maxSteps: 15
tags: [audiences, operations]
---

# RPI Audiences

You are an audience operations specialist...

## What You Can Do
- List and inspect audiences and their definitions
- Read audience metadata
- Run the audience test-workflow lifecycle and read its results

## Guidelines
- Confirm write operations with the user
- Provide context alongside raw data
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique skill identifier |
| `title` | No | Display name |
| `description` | Yes | Short description shown in the skill catalog |
| `type` | No | `action`, `expert`, or `hybrid` (default: `action`) |
| `mcpToolFilter` | No | Array of MCP tool names this skill can access |
| `maxSteps` | No | Max tool-call steps for the sub-agent (default: 10, max: 50) |
| `tags` | No | Categorization tags |

## Skill Router Pattern

When skills are loaded, the agent operates in a two-tier mode that separates knowledge from action:

### Expert skills (inlined into the system prompt)

Expert skills have no tools -- their value is domain knowledge. Instead of routing them through `execute_skill`, `buildRouterSystemPrompt()` injects their full SKILL.md instructions directly into the system prompt as "Domain Knowledge" sections. The agent can answer knowledge questions immediately without any tool call.

### Action/hybrid skills (routed via `execute_skill`)

Action and hybrid skills appear in a compact **skill catalog** (~500 tokens) listing each skill's name and description. The agent has a single `execute_skill` meta-tool to dispatch work to these skills:

1. The agent analyzes the user's request
2. For knowledge questions, it answers directly from the inlined domain knowledge
3. For action requests, it calls `execute_skill(skillName, taskDescription)`
4. A **sub-agent** spawns with only that skill's MCP tools and the SKILL.md body as system context
5. The sub-agent executes the task and returns the result to the router
6. The router presents the result to the user

```
User: "What's the difference between a selection rule and an audience?"
  -> Agent answers directly from the inlined rpi-foundation-expert knowledge
  <- No tool call needed

User: "List my audiences"
  -> Router: execute_skill("rpi-audiences", "list all audiences")
    -> Sub-agent (has only the rpi-audiences MCP tools)
      -> MCP: list_audiences()
      -> Result: [ "VIP", "Lapsed", ... ]
    <- "Here are your audiences: VIP, Lapsed, ..."
  <- Router relays to user
```

If a workspace has only expert skills, no `execute_skill` tool is added at all -- the knowledge is already in the prompt.

**Why?** Without the router, exposing all 47 MCP tools costs ~15k tokens per request. The skill catalog reduces this to ~500 tokens while maintaining full tool access through sub-agents. Inlining expert knowledge eliminates unnecessary tool-call round trips for knowledge questions.

## Expert roster & current wiring

Two expert skills ship in `skills/experts/` today, both wired into the seeded RedpointAI workspace by default. `rpi-foundation-expert` is **inlined** into the router prompt (X-ClientID, RPI terminology, display/error conventions) — guidance that applies to every RPI tool call. `rpi-domain-expert` is **dispatched** — campaign-building knowledge (attributes, selection rules (segments), audiences, interactions, and the design strategy behind them) loaded into a sub-agent only on a knowledge-intent hit, so it costs the parent prompt nothing.

Inlining is deliberately reserved for the one cross-cutting expert. Each inlined expert adds ~1.5–2k prompt tokens, and on a contended 10K-TPM-per-request Azure deployment, stacking several overflows the window and 429s every call. Deeper domain *knowledge* (campaign design, segmentation strategy, and the like) therefore ships as a **dispatched** expert (`rpi-domain-expert`) — loaded into a sub-agent on demand, so it costs the parent prompt nothing. Routing stays catalog-driven through the action skills (`execute_skill`), so the agent can *act* across every domain regardless. The wiring choice lives in `apps/server/src/store/seed.ts` (`config.skills`) and is applied at load time by `registry.filterByNames()`.

**To bring an expert in:**

1. Refine its `skills/experts/<name>/SKILL.md` body.
2. Add its name to the workspace `config.skills` array — in `seed.ts` for the seeded default, or the workspace's DB-row config for a single workspace.
3. Budget for it: each inlined expert adds roughly 1.5–2k prompt tokens. Stay under the deployment's per-request TPM ceiling — a less-contended deployment (e.g. `gpt-4.1`'s 100K bucket) comfortably fits several; see [providers](providers.md).
4. Restart the server — skills load at startup.

## Directory Structure

```
skills/
  rpi-audiences/SKILL.md            # Action skill (the how — MCP tools)
  experts/
    rpi-foundation-expert/SKILL.md  # Expert skill (knowledge only, inlined)
    rpi-domain-expert/SKILL.md      # Expert skill (knowledge only, dispatched)
```

## Creating a Custom Skill

1. Create a directory under `skills/`:
   ```bash
   mkdir skills/my-custom-skill
   ```

2. Add a `SKILL.md` file with frontmatter and instructions:
   ```markdown
   ---
   name: my-custom-skill
   description: Custom skill for my specific use case
   type: action
   mcpToolFilter:
     - tool_one
     - tool_two
   ---
   
   # My Custom Skill
   
   Instructions for the sub-agent...
   ```

3. Restart the server -- skills are loaded on startup from the `skills/` directory

4. Add the skill name to a workspace's `skills` array to enable it

## Skill Loading

Skills are loaded once on server startup by scanning the `skills/` directory recursively for `SKILL.md` files. The `packages/skills` package provides:

- `loadSkillsFromDirectory()` — parses SKILL.md files from disk
- `SkillRegistry` — registers and catalogs loaded skills
- `createSkillRouterTool()` — builds the `execute_skill` tool for action/hybrid skills
- `buildRouterSystemPrompt(basePrompt, skills)` — inlines expert skill knowledge into the system prompt and builds a compact catalog for action/hybrid skills
