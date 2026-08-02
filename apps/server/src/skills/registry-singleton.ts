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
 *
 * We cache the load *promise*, not the registry, so concurrent first-callers
 * all await the same fully-populated result. Caching a mutable registry that
 * is assigned before its `await loadSkillsFromDirectory(...)` resolves let a
 * second caller arriving mid-load observe an EMPTY registry — which surfaced
 * as a spurious "category-discovery" tier in runtime-status (0 skills → no
 * dispatchable skill → Tier 2) that stuck for the 30s status cache TTL.
 */
let skillRegistryPromise: Promise<SkillRegistry> | null = null;
export function getSkillRegistry(): Promise<SkillRegistry> {
  if (!skillRegistryPromise) {
    skillRegistryPromise = (async () => {
      const registry = new SkillRegistry();
      try {
        const skills = await loadSkillsFromDirectory(SKILLS_DIR);
        skills.forEach((s) => registry.register(s));
        logger.info({ count: skills.length, dir: SKILLS_DIR }, "Skills loaded");
      } catch {
        logger.warn({ dir: SKILLS_DIR }, "No skills directory found, continuing without skills");
      }
      return registry;
    })();
  }
  return skillRegistryPromise;
}
