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
    expect(names).toEqual([
      "deploy",
      "deps",
      "frontend-design",
      "particles-3d",
      "personal-site",
      "preview",
      "remotion",
      "storefront",
      "stripe",
      "supabase",
      "web",
      "workspace-unix",
    ]);
    for (const skill of catalog) {
      expect(skill.description.length).toBeGreaterThan(20);
    }
  });

  it("includes SKILL.md and deps scripts", () => {
    const files = loadSkillFiles();
    const paths = files.map((file) => file.sandboxPath);
    expect(paths).toContain(".baby/skills/preview/SKILL.md");
    expect(paths).toContain(".baby/skills/frontend-design/SKILL.md");
    expect(paths).toContain(".baby/skills/remotion/SKILL.md");
    expect(paths).toContain(".baby/skills/particles-3d/SKILL.md");
    expect(paths).toContain(".baby/skills/storefront/SKILL.md");
    expect(paths).toContain(".baby/skills/supabase/SKILL.md");
    expect(paths).toContain(".baby/skills/stripe/SKILL.md");
    expect(paths).toContain(".baby/skills/deploy/SKILL.md");
    expect(paths).toContain(".baby/skills/personal-site/SKILL.md");
    expect(paths).toContain(".baby/skills/deps/scripts/add.sh");
    expect(paths).toContain(".baby/skills/web/scripts/search.sh");
    expect(paths).toContain(".baby/skills/web/scripts/fetch.sh");
  });

  it("formats L0 prompt without SKILL.md bodies", () => {
    const prompt = formatSkillCatalogPrompt();
    expect(prompt).toContain("workspace-unix:");
    expect(prompt).toContain("progressive disclosure");
    expect(prompt).not.toContain("Prefer **one**");
  });
});
