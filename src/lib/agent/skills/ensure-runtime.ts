import fs from "node:fs";
import path from "node:path";

import type { ProjectSandbox } from "@/lib/sandbox/types";
import { readDevLogLines } from "@/lib/sandbox/daytona/app-server-health";

import {
  loadSkillCatalog,
  loadSkillFiles,
  skillCatalogStamp,
  skillIndexTsv,
} from "./catalog";

export const BABY_RUNTIME_ROOT = ".baby";
const STAMP_PATH = `${BABY_RUNTIME_ROOT}/.stamp`;
const INDEX_PATH = `${BABY_RUNTIME_ROOT}/skills/index.tsv`;
const BABY_BIN_PATH = `${BABY_RUNTIME_ROOT}/bin/baby`;
const PREVIEW_LOG_PATH = `${BABY_RUNTIME_ROOT}/logs/preview.log`;
const PREVIEW_LOG_LINES = 200;

function babyBinSource(repoRoot = process.cwd()): string {
  return fs.readFileSync(
    path.join(repoRoot, "src/lib/agent/skills/baby.sh"),
    "utf8",
  );
}

function parentDirs(filePath: string): string[] {
  const parts = filePath.replace(/\\/g, "/").split("/");
  const dirs: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join("/"));
  }
  return dirs;
}

async function ensureDir(sandbox: ProjectSandbox, dir: string): Promise<void> {
  try {
    await sandbox.fs.createFolder(dir);
  } catch {
    // Already exists.
  }
}

async function readStamp(sandbox: ProjectSandbox): Promise<string | null> {
  try {
    return (await sandbox.fs.readTextFile(STAMP_PATH)).trim();
  } catch {
    return null;
  }
}

/**
 * Project platform skills + baby CLI into the sandbox working tree.
 * Idempotent via `.baby/.stamp`. Not part of Freestyle user source.
 */
export async function ensureBabyRuntime(
  sandbox: ProjectSandbox,
  repoRoot = process.cwd(),
): Promise<void> {
  const catalog = loadSkillCatalog(repoRoot);
  const skillFiles = loadSkillFiles(repoRoot);
  const babyBin = babyBinSource(repoRoot);
  const index = skillIndexTsv(catalog);
  const stamp = skillCatalogStamp(skillFiles, [
    { path: BABY_BIN_PATH, content: babyBin },
    { path: INDEX_PATH, content: index },
  ]);

  if ((await readStamp(sandbox)) === stamp) {
    return;
  }

  const writes: Array<{ path: string; content: string }> = [
    ...skillFiles.map((file) => ({
      path: file.sandboxPath,
      content: file.content,
    })),
    { path: INDEX_PATH, content: `${index}\n` },
    { path: BABY_BIN_PATH, content: babyBin },
    { path: STAMP_PATH, content: `${stamp}\n` },
  ];

  const dirs = new Set<string>([
    BABY_RUNTIME_ROOT,
    `${BABY_RUNTIME_ROOT}/bin`,
    `${BABY_RUNTIME_ROOT}/logs`,
    `${BABY_RUNTIME_ROOT}/skills`,
  ]);
  for (const file of writes) {
    for (const dir of parentDirs(file.path)) {
      dirs.add(dir);
    }
  }
  const orderedDirs = [...dirs].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  for (const dir of orderedDirs) {
    await ensureDir(sandbox, dir);
  }
  for (const file of writes) {
    await sandbox.fs.writeTextFile(file.path, file.content);
  }

  await sandbox.process.executeCommand(
    "chmod +x .baby/bin/baby && find .baby/skills -type f -name '*.sh' -exec chmod +x {} +",
    ".",
    undefined,
    15,
  );
}

/** Mirror recent Next dev-log lines so agents can `tail` without touching `.next`. */
export async function refreshPreviewLogMirror(
  sandbox: ProjectSandbox,
): Promise<void> {
  await ensureDir(sandbox, `${BABY_RUNTIME_ROOT}/logs`);
  const text = await readDevLogLines(sandbox, PREVIEW_LOG_LINES);
  await sandbox.fs.writeTextFile(PREVIEW_LOG_PATH, text);
}
