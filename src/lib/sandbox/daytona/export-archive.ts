import { ensureDesiredState } from "./runtime-reconciler";
import { getExistingDaytonaSandbox } from "./sandbox";
import { DAYTONA_WORKSPACE_ROOT } from "./config";
import type { DaytonaProjectSandbox } from "./provider";
import { getSession } from "@/lib/session/store";
import { NotImplementedError, type ProjectSandbox } from "../types";
import { commitWorkspaceTurn } from "../workspace-git";

export type ExportArchiveSource = "sandbox-git";

export interface ExportArchiveResult {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  source: ExportArchiveSource;
}

const EXPORT_ZIP_PATH = "/tmp/baby-lovable-export.zip";

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
      // Fresh tree with no commits yet — create one.
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

/** Export live sandbox workspace via git archive. */
async function exportDaytonaArchive(
  sessionId: string,
  title?: string,
): Promise<ExportArchiveResult> {
  await ensureDesiredState(sessionId, "sandbox-ready", { wait: true });
  const sandbox = await getExistingDaytonaSandbox(sessionId, { wake: true });
  if (!sandbox) {
    throw new Error(`Daytona sandbox not available for export: ${sessionId}`);
  }
  const filename = archiveFilename(sessionId, title);

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
