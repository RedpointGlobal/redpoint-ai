/**
 * A2A Agent Card builder.
 *
 * Reads the currently-loaded SkillRegistry and produces a valid A2A AgentCard.
 * Each loaded Skill becomes one A2A AgentSkill entry.
 *
 * The Agent Card is served unauthenticated at /.well-known/agent-card.json so
 * other agents can discover what this agent can do before calling it.
 *
 * Ported from RP-Vercel-Agent v3 (src/a2a/server/agent-card.ts).
 */

import type { AgentCard } from "@a2a-js/sdk";
import type { Skill } from "@redpoint-ai/skills";

export interface AgentCardInputs {
  skills: Skill[];
  /** Base URL where this A2A server is reachable (e.g. "http://localhost:4100") */
  baseUrl: string;
}

/**
 * Build the Agent Card for this agent from the currently loaded skills.
 * Pure function — deterministic output given the same input.
 */
export function buildAgentCard({ skills, baseUrl }: AgentCardInputs): AgentCard {
  return {
    protocolVersion: "0.3.0",
    name: "redpoint-ai-agent",
    description: "Redpoint AI agent — RPI integration via skill routing",
    version: "0.1.0",
    url: baseUrl,
    preferredTransport: "JSONRPC",
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: skills.map((skill) => ({
      id: skill.name,
      name: skill.name,
      description: skill.description,
      tags: skill.tags ?? [],
    })),
    securitySchemes: {
      bearer: {
        type: "http",
        scheme: "bearer",
      },
    },
    security: [{ bearer: [] }],
  };
}
