/**
 * Local sandbox lifecycle (L1).
 * Parallel to daytona/sandbox.ts — here "sandbox" = workspace on disk.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { getWorkspaceRoot } from "../paths";
import type { SandboxStatus } from "../preview-types";

const NEXTJS_STARTER_TEMPLATE = path.join(
  process.cwd(),
  "templates",
  "nextjs-starter",
);

async function isWorkspaceEmpty(workspaceRoot: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(workspaceRoot);
    return entries.length === 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

async function seedWorkspaceFromTemplate(workspaceRoot: string): Promise<void> {
  try {
    await fs.access(NEXTJS_STARTER_TEMPLATE);
  } catch {
    throw new Error(
      `Starter template not found: ${NEXTJS_STARTER_TEMPLATE}`,
    );
  }

  await fs.mkdir(workspaceRoot, { recursive: true });
  await fs.cp(NEXTJS_STARTER_TEMPLATE, workspaceRoot, {
    recursive: true,
    filter: (source) => {
      if (source.endsWith(".DS_Store")) {
        return false;
      }

      const relative = path.relative(NEXTJS_STARTER_TEMPLATE, source);
      if (
        relative === "node_modules" ||
        relative.startsWith(`node_modules${path.sep}`)
      ) {
        return false;
      }

      return true;
    },
  });
}

/** Local sandbox status — workspace exists or not. Never creates. */
export async function getLocalSandboxStatus(
  sessionId: string,
): Promise<SandboxStatus> {
  try {
    await fs.access(getWorkspaceRoot(sessionId));
    return "running";
  } catch {
    return "missing";
  }
}

/** Create workspace from template if missing/empty. */
export async function ensureWorkspace(
  sessionId: string,
  userId: string | null = null,
): Promise<string> {
  const workspaceRoot = getWorkspaceRoot(sessionId, userId);

  if (await isWorkspaceEmpty(workspaceRoot)) {
    await fs.mkdir(path.dirname(workspaceRoot), { recursive: true });
    await seedWorkspaceFromTemplate(workspaceRoot);
  }

  return workspaceRoot;
}
