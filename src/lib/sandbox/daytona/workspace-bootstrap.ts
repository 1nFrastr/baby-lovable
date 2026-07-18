import type { Session } from "@/lib/session/types";

import type { DaytonaProjectSandbox } from "./provider";
import { resolvePackageManager } from "../package-manager";
import { initWorkspaceGit } from "../workspace-git";
import { logDaytonaBootstrap } from "./bootstrap-log";
import { DAYTONA_WORKSPACE_ROOT } from "./config";
import { readStarterTemplateFiles } from "./template-seed";

const PNPM_BOOTSTRAP =
  "corepack enable && corepack prepare pnpm@10.12.1 --activate || npm install -g pnpm@10.12.1";

export interface WorkspaceBootstrapResult {
  seeded: boolean;
  gitInitSha?: string;
}

async function pathExists(
  sandbox: DaytonaProjectSandbox,
  targetPath: string,
): Promise<boolean> {
  try {
    await sandbox.fs.getFileDetails(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isWorkspaceEmpty(sandbox: DaytonaProjectSandbox): Promise<boolean> {
  try {
    const files = await sandbox.fs.listFiles(".");
    return files.length === 0;
  } catch {
    return true;
  }
}

async function installPnpm(sandbox: DaytonaProjectSandbox): Promise<boolean> {
  const result = await sandbox.process.executeCommand(
    PNPM_BOOTSTRAP,
    ".",
    undefined,
    180,
  );
  return result.exitCode === 0;
}

async function seedFromTemplate(sandbox: DaytonaProjectSandbox): Promise<void> {
  const files = await readStarterTemplateFiles();
  logDaytonaBootstrap(
    sandbox.id,
    "seed",
    `uploading ${files.length} starter files via uploadFiles`,
  );

  try {
    await sandbox.sdkSandbox.fs.createFolder(DAYTONA_WORKSPACE_ROOT, "755");
  } catch {
    // Workspace root may already exist.
  }

  await sandbox.sdkSandbox.fs.uploadFiles(
    files.map((file) => ({
      source: file.content,
      destination: `${DAYTONA_WORKSPACE_ROOT}/${file.relativePath}`,
    })),
  );
}

async function ensureGitInitialized(
  sandbox: DaytonaProjectSandbox,
): Promise<string | undefined> {
  const init = await initWorkspaceGit(sandbox);
  return init.sha ?? undefined;
}

async function ensurePnpmAvailable(sandbox: DaytonaProjectSandbox, sessionId: string) {
  const pm = resolvePackageManager("daytona");
  const check = await sandbox.process.executeCommand(
    `${pm.pm} --version`,
    ".",
    undefined,
    30,
  );
  if (check.exitCode !== 0) {
    logDaytonaBootstrap(sessionId, "workspace", "installing pnpm");
    await installPnpm(sandbox);
  }
}

/**
 * Prepare the sandbox local workspace.
 * Returns bootstrap result only — caller persists session / runtime state.
 */
export async function ensureDaytonaWorkspace(
  sandbox: DaytonaProjectSandbox,
  session: Session,
): Promise<WorkspaceBootstrapResult> {
  logDaytonaBootstrap(session.id, "workspace", "checking workspace state");
  const [empty, hasPackageJson] = await Promise.all([
    isWorkspaceEmpty(sandbox),
    pathExists(sandbox, "package.json"),
  ]);

  if (empty || !hasPackageJson) {
    logDaytonaBootstrap(session.id, "workspace", "seeding starter template");
    await seedFromTemplate(sandbox);
    logDaytonaBootstrap(session.id, "workspace", "installing pnpm");
    await installPnpm(sandbox);
    const gitInitSha = await ensureGitInitialized(sandbox);
    logDaytonaBootstrap(session.id, "workspace", "workspace ready (seeded)");
    return { seeded: true, gitInitSha };
  }

  await ensurePnpmAvailable(sandbox, session.id);
  let gitInitSha: string | undefined;
  if (!session.lastCommitSha) {
    gitInitSha = await ensureGitInitialized(sandbox);
  }
  logDaytonaBootstrap(session.id, "workspace", "workspace ready (existing project)");
  return { seeded: false, gitInitSha };
}
