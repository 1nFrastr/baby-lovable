import type { Session } from "@/lib/session/types";
import { updateSession } from "@/lib/session/store";

import type { DaytonaProjectSandbox } from "../daytona-provider";
import { resolvePackageManager } from "../package-manager";
import { initWorkspaceGit } from "../workspace-git";
import { logDaytonaBootstrap } from "./bootstrap-log";
import { DAYTONA_WORKSPACE_ROOT } from "./config";
import { readStarterTemplateFiles } from "./template-seed";
import {
  restoreDaytonaWorkspaceFromVolume,
  volumeHasSource,
} from "./volume-sync";

const PNPM_BOOTSTRAP =
  "corepack enable && corepack prepare pnpm@10.12.1 --activate || npm install -g pnpm@10.12.1";

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
  session: Session,
): Promise<void> {
  const init = await initWorkspaceGit(sandbox);
  if (init.sha) {
    await updateSession(session.id, { lastCommitSha: init.sha });
  }
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
 * Prepare the sandbox local workspace. Snapshot-backed sandboxes already have
 * starter + node_modules; volume restore covers resumed sessions.
 *
 * Initial seed intentionally does NOT persist to volume — that sync is slow and
 * starter content is deterministic. First real persist happens after an agent turn.
 */
export async function ensureDaytonaWorkspace(
  sandbox: DaytonaProjectSandbox,
  session: Session,
): Promise<void> {
  logDaytonaBootstrap(session.id, "workspace", "checking workspace state");
  const [empty, hasPackageJson, hasVolumeSource] = await Promise.all([
    isWorkspaceEmpty(sandbox),
    pathExists(sandbox, "package.json"),
    volumeHasSource(sandbox),
  ]);

  // Only restore from volume when the local workspace has no project yet.
  // Reused sandboxes keep their local disk state (incl. node_modules).
  let restored = false;
  if ((empty || !hasPackageJson) && hasVolumeSource) {
    logDaytonaBootstrap(session.id, "workspace", "restoring source from volume");
    restored = await restoreDaytonaWorkspaceFromVolume(sandbox);
    if (restored) {
      logDaytonaBootstrap(session.id, "workspace", "restored source from volume");
    }
  }

  if (!restored && (empty || !hasPackageJson)) {
    logDaytonaBootstrap(session.id, "workspace", "seeding starter template");
    await seedFromTemplate(sandbox);
    logDaytonaBootstrap(session.id, "workspace", "installing pnpm");
    await installPnpm(sandbox);
    logDaytonaBootstrap(
      session.id,
      "workspace",
      "skipping initial volume persist (deferred to post-turn)",
    );
    await ensureGitInitialized(sandbox, session);
    logDaytonaBootstrap(session.id, "workspace", "workspace ready (seeded)");
    return;
  }

  const [stillEmpty, stillHasPkg] = await Promise.all([
    isWorkspaceEmpty(sandbox),
    pathExists(sandbox, "package.json"),
  ]);
  if (stillEmpty || !stillHasPkg) {
    logDaytonaBootstrap(session.id, "workspace", "seeding starter template (fallback)");
    await seedFromTemplate(sandbox);
    logDaytonaBootstrap(session.id, "workspace", "installing pnpm");
    await installPnpm(sandbox);
    logDaytonaBootstrap(
      session.id,
      "workspace",
      "skipping initial volume persist (deferred to post-turn)",
    );
    await ensureGitInitialized(sandbox, session);
    logDaytonaBootstrap(session.id, "workspace", "workspace ready (seeded fallback)");
    return;
  }

  await ensurePnpmAvailable(sandbox, session.id);
  if (!session.lastCommitSha) {
    await ensureGitInitialized(sandbox, session);
  }
  logDaytonaBootstrap(session.id, "workspace", "workspace ready (existing project)");
}
