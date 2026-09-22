import { describe, expect, it } from "vitest";

import {
  formatSkillCatalogPrompt,
  loadSkillCatalog,
  loadSkillFiles,
} from "./catalog";

describe("skill catalog", () => {
  it("loads platform skills with name and description", () => {
    const catalog = loadSkillCatalog();
    const names = catalog.map((skill) => skill.name).sort();
    expect(names).toEqual(["deps", "preview", "workspace-unix"]);
    for (const skill of catalog) {
      expect(skill.description.length).toBeGreaterThan(20);
    }
  });

  it("includes SKILL.md and deps scripts", () => {
    const files = loadSkillFiles();
    const paths = files.map((file) => file.sandboxPath);
    expect(paths).toContain(".baby/skills/preview/SKILL.md");
    expect(paths).toContain(".baby/skills/deps/scripts/add.sh");
  });

  it("formats L0 prompt without SKILL.md bodies", () => {
    const prompt = formatSkillCatalogPrompt();
    expect(prompt).toContain("workspace-unix:");
    expect(prompt).toContain("progressive disclosure");
    expect(prompt).not.toContain("Prefer **one**");
  });
});
