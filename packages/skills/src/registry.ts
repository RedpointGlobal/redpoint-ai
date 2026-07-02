import type { Skill } from "./skill.js";

export class SkillRegistry {
  private skills = new Map<string, Skill>();

  register(skill: Skill): void {
    this.skills.set(skill.name, skill);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  filterByNames(names: string[]): Skill[] {
    return names
      .map((n) => this.skills.get(n))
      .filter((s): s is Skill => s !== undefined);
  }
}
