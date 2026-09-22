import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Host-filesystem skill catalog. Do not statically import this module from
 * `'use workflow'` files — Node `fs` / `path` / `crypto` are banned in the
 * workflow sandbox. Load via `'use step'` + dynamic import instead.
 */

export type SkillMeta = {
  name: string;
  description: string;
  dirName: string;
};

export type SkillFile = {
  sandboxPath: string;
  content: string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

export function skillsRoot(repoRoot = process.cwd()): string {
  return path.join(repoRoot, "skills");
}

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) {
    return {};
  }
  const block = match[1] ?? "";
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return {
    name: name?.replace(/^['"]|['"]$/g, ""),
    description: description?.replace(/^['"]|['"]$/g, ""),
  };
}

function listSkillDirs(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadSkillCatalog(repoRoot = process.cwd()): SkillMeta[] {
  const root = skillsRoot(repoRoot);
  const catalog: SkillMeta[] = [];
  for (const dirName of listSkillDirs(root)) {
    const skillMd = path.join(root, dirName, "SKILL.md");
    if (!fs.existsSync(skillMd)) {
      continue;
    }
    const raw = fs.readFileSync(skillMd, "utf8");
    const meta = parseFrontmatter(raw);
    catalog.push({
      name: meta.name || dirName,
      description: meta.description || `Skill ${dirName}`,
      dirName,
    });
  }
  return catalog;
}

function walkFiles(directory: string, prefix: string, files: SkillFile[]): void {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkFiles(abs, rel, files);
      continue;
    }
    files.push({
      sandboxPath: `.baby/skills/${rel.replace(/\\/g, "/")}`,
      content: fs.readFileSync(abs, "utf8"),
    });
  }
}

export function loadSkillFiles(repoRoot = process.cwd()): SkillFile[] {
  const root = skillsRoot(repoRoot);
  const files: SkillFile[] = [];
  if (!fs.existsSync(root)) {
    return files;
  }
  walkFiles(root, "", files);
  return files.sort((a, b) => a.sandboxPath.localeCompare(b.sandboxPath));
}

export function skillIndexTsv(catalog: SkillMeta[]): string {
  return catalog
    .map((skill) => `${skill.name}\t${skill.description}`)
    .join("\n");
}

export function skillCatalogStamp(
  files: SkillFile[],
  extra: Array<{ path: string; content: string }> = [],
): string {
  const hash = createHash("sha256");
  const rows = [
    ...files.map((file) => ({ path: file.sandboxPath, content: file.content })),
    ...extra,
  ].sort((a, b) => a.path.localeCompare(b.path));
  for (const row of rows) {
    hash.update(row.path);
    hash.update("\0");
    hash.update(row.content);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/** L0 prompt block: name + one-line description only. */
export function formatSkillCatalogPrompt(catalog = loadSkillCatalog()): string {
  if (catalog.length === 0) {
    return "";
  }
  const lines = catalog.map((skill) => `- ${skill.name}: ${skill.description}`);
  return [
    "Skills (progressive disclosure — read `.baby/skills/<name>/SKILL.md` only when needed, then exec; do not load all):",
    ...lines,
    "Discover with `exec({ command: \"baby skills\" })` or `baby skill <name>`.",
  ].join("\n");
}
