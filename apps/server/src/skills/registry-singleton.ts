import { loadSkillsFromDirectory, SkillRegistry } from "@redpoint-ai/skills";
import { logger } from "../lib/logger.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(__dirname, "../../../../skills");

/**
 * Process-wide skill registry singleton. Loaded lazily on first call.
 *
 * Lives outside the chat route so other routes (workspaces runtime-status,
 * future endpoints) can read the registry without dragging chat.ts and its
 * heavy import graph (orchestrator, hallucination detector, metrics) along.
 */
let skillRegistry: SkillRegistry | null = null;
export async function getSkillRegistry(): Promise<SkillRegistry> {
  if (!skillRegistry) {
    skillRegistry = new SkillRegistry();
    try {
      const skills = await loadSkillsFromDirectory(SKILLS_DIR);
      skills.forEach((s) => skillRegistry!.register(s));
      logger.info({ count: skills.length, dir: SKILLS_DIR }, "Skills loaded");
    } catch {
      logger.warn({ dir: SKILLS_DIR }, "No skills directory found, continuing without skills");
    }
  }
  return skillRegistry;
}
