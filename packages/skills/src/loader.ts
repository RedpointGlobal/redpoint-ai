import matter from "gray-matter";
import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { SkillFrontmatterSchema, inferSkillType, type Skill } from "./skill.js";

/**
 * Load a single skill from a SKILL.md file.
 */
export async function loadSkillFromFile(filePath: string): Promise<Skill> {
  const raw = await readFile(filePath, "utf-8");
  const { data, content } = matter(raw);

  const frontmatter = SkillFrontmatterSchema.parse(data);
  const resolvedType =
    frontmatter.type ?? inferSkillType(frontmatter.mcpToolFilter, content);

  return {
    name: frontmatter.name,
    title: frontmatter.title,
    description: frontmatter.description,
    type: resolvedType,
    instructions: content.trim(),
    mcpToolFilter: frontmatter.mcpToolFilter,
    maxSteps: frontmatter.maxSteps,
    tags: frontmatter.tags,
    operations: frontmatter.operations,
    dispatch: frontmatter.dispatch,
    clientIdFoundation: frontmatter.clientIdFoundation,
    dateGrounding: frontmatter.dateGrounding,
  };
}

/**
 * Load all skills from a directory (recursively looks for SKILL.md files).
 */
export async function loadSkillsFromDirectory(
  dirPath: string,
): Promise<Skill[]> {
  const skills: Skill[] = [];

  async function scanDir(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await scanDir(fullPath);
      } else if (entry.name === "SKILL.md") {
        try {
          const skill = await loadSkillFromFile(fullPath);
          skills.push(skill);
        } catch (err) {
          console.error(`Failed to load skill from ${fullPath}:`, err);
        }
      }
    }
  }

  await scanDir(dirPath);
  return skills;
}
