import fs from "node:fs/promises";
import path from "node:path";

const STARTER_TEMPLATE = path.join(
  process.cwd(),
  "templates",
  "nextjs-starter",
);

export async function readStarterTemplateFiles(): Promise<
  Array<{ relativePath: string; content: Buffer }>
> {
  const files: Array<{ relativePath: string; content: Buffer }> = [];

  async function walk(directory: string, prefix = ""): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store") {
        continue;
      }

      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);

      if (relative === "node_modules" || relative.startsWith("node_modules/")) {
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }

      const content = await fs.readFile(absolute);
      files.push({ relativePath: relative, content });
    }
  }

  await walk(STARTER_TEMPLATE);
  return files;
}
