import { getOrCreateDaytonaSandbox } from "./daytona/sandbox-manager";
import {
  stageVolumeSourceToPath,
  volumeHasSource,
} from "./daytona/volume-sync";
import { DAYTONA_WORKSPACE_ROOT } from "./daytona/config";
import type { DaytonaProjectSandbox } from "./daytona-provider";
import { getSession } from "@/lib/session/store";
import { NotImplementedError, type ProjectSandbox } from "./types";
import { commitWorkspaceTurn } from "./workspace-git";

export type ExportArchiveSource = "volume" | "sandbox-git";

export interface ExportArchiveResult {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  source: ExportArchiveSource;
}

const EXPORT_ZIP_PATH = "/tmp/baby-lovable-export.zip";
const EXPORT_STAGING_DIR = "/tmp/baby-lovable-export-staging";

const GIT_NAME = "baby-lovable";
const GIT_EMAIL = "agent@baby-lovable.local";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function archiveFilename(sessionId: string, title?: string): string {
  const raw = (title ?? sessionId).trim() || sessionId;
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || sessionId}-workspace.zip`;
}

async function downloadExportZip(
  daytona: DaytonaProjectSandbox,
): Promise<Uint8Array> {
  const buffer = await daytona.sdkSandbox.fs.downloadFile(EXPORT_ZIP_PATH);
  return new Uint8Array(buffer);
}

async function gitArchiveAt(
  sandbox: ProjectSandbox,
  repoDir: string,
): Promise<void> {
  const ensure = await sandbox.process.executeCommand(
    [
      "git rev-parse --is-inside-work-tree >/dev/null 2>&1",
      "|| (git init -b main",
      `&& git config user.email ${shellQuote(GIT_EMAIL)}`,
      `&& git config user.name ${shellQuote(GIT_NAME)})`,
    ].join(" "),
    repoDir,
    undefined,
    60,
  );
  if (ensure.exitCode !== 0) {
    throw new Error(`git ensure failed in ${repoDir}`);
  }

  const status = await sandbox.process.executeCommand(
    "git status --porcelain",
    repoDir,
    undefined,
    60,
  );
  if (status.exitCode === 0 && status.stdout.trim()) {
    const commit = await sandbox.process.executeCommand(
      [
        "git add -A",
        `&& git commit -m ${shellQuote("checkpoint: export")}`,
      ].join(" "),
      repoDir,
      undefined,
      120,
    );
    if (commit.exitCode !== 0) {
      // Empty commit / nothing to commit — continue if HEAD exists.
      const head = await sandbox.process.executeCommand(
        "git rev-parse --verify HEAD",
        repoDir,
        undefined,
        30,
      );
      if (head.exitCode !== 0) {
        throw new Error("git commit failed before export; no HEAD");
      }
    }
  } else {
    const head = await sandbox.process.executeCommand(
      "git rev-parse --verify HEAD",
      repoDir,
      undefined,
      30,
    );
    if (head.exitCode !== 0) {
      // Fresh tree with no commits yet (e.g. only tracked nothing) — create one.
      const bootstrap = await sandbox.process.executeCommand(
        [
          "git add -A",
          `&& git commit --allow-empty -m ${shellQuote("checkpoint: export")}`,
        ].join(" "),
        repoDir,
        undefined,
        120,
      );
      if (bootstrap.exitCode !== 0) {
        throw new Error("git bootstrap commit failed before export");
      }
    }
  }

  await sandbox.process.executeCommand(
    `rm -f ${shellQuote(EXPORT_ZIP_PATH)}`,
    "/",
    undefined,
    30,
  );

  const archive = await sandbox.process.executeCommand(
    `git archive --format=zip -o ${shellQuote(EXPORT_ZIP_PATH)} HEAD`,
    repoDir,
    undefined,
    120,
  );
  if (archive.exitCode !== 0) {
    throw new Error(`git archive failed in ${repoDir}`);
  }
}

/**
 * Prefer durable volume source-of-truth. If the user exports before the first
 * persist, fall back to the live sandbox workspace git tree.
 */
async function exportDaytonaArchive(
  sessionId: string,
  title?: string,
): Promise<ExportArchiveResult> {
  const sandbox = await getOrCreateDaytonaSandbox(sessionId);
  const filename = archiveFilename(sessionId, title);

  if (await volumeHasSource(sandbox)) {
    const count = await stageVolumeSourceToPath(sandbox, EXPORT_STAGING_DIR);
    if (count === 0) {
      throw new Error("volume has package.json but no exportable source files");
    }
    await gitArchiveAt(sandbox, EXPORT_STAGING_DIR);
    const bytes = await downloadExportZip(sandbox);
    return {
      filename,
      contentType: "application/zip",
      bytes,
      source: "volume",
    };
  }

  // Pre-persist path: commit working tree then archive sandbox git.
  try {
    await commitWorkspaceTurn(sandbox, {
      turnIndex: 0,
      userPrompt: "",
      messageOverride: "checkpoint: export",
    });
  } catch {
    // Best-effort; gitArchiveAt will still try to produce HEAD.
  }

  await gitArchiveAt(sandbox, DAYTONA_WORKSPACE_ROOT);
  const bytes = await downloadExportZip(sandbox);
  return {
    filename,
    contentType: "application/zip",
    bytes,
    source: "sandbox-git",
  };
}

/**
 * Export the session workspace as a zip of the git tree at HEAD.
 *
 * Daytona: volume (durable SoT) when populated; otherwise live sandbox git.
 * Local: not implemented yet — interface reserved.
 */
export async function exportWorkspaceArchive(
  sessionId: string,
): Promise<ExportArchiveResult> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (session.sandboxMode === "local") {
    throw new NotImplementedError("Local workspace archive export");
  }

  return exportDaytonaArchive(sessionId, session.title);
}
