import { ensureDesiredState } from "./runtime-reconciler";
import { getExistingDaytonaSandbox } from "./sandbox";
import { DAYTONA_WORKSPACE_ROOT } from "./config";
import type { DaytonaProjectSandbox } from "./provider";
import { getSession } from "@/lib/session/store";
import { NotImplementedError, type ProjectSandbox } from "../types";

export type ExportArchiveSource = "sandbox-zip";

export interface ExportArchiveResult {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  source: ExportArchiveSource;
}

const EXPORT_ZIP_PATH = "/tmp/baby-lovable-export.zip";

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

/** Zip the workspace tree without requiring a git repository. */
async function zipWorkspaceAt(
  sandbox: ProjectSandbox,
  workspaceDir: string,
): Promise<void> {
  const archive = await sandbox.process.executeCommand(
    `rm -f ${EXPORT_ZIP_PATH} && (cd ${workspaceDir} && zip -rq ${EXPORT_ZIP_PATH} . -x './.git/*' './node_modules/*' './.next/*')`,
    workspaceDir,
    undefined,
    120,
  );
  if (archive.exitCode !== 0) {
    throw new Error(
      `workspace zip failed in ${workspaceDir}: ${archive.stdout || archive.stderr || "unknown error"}`,
    );
  }
}

/** Export live sandbox workspace as a plain zip (no git). */
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

  await zipWorkspaceAt(sandbox, DAYTONA_WORKSPACE_ROOT);
  const bytes = await downloadExportZip(sandbox);
  return {
    filename,
    contentType: "application/zip",
    bytes,
    source: "sandbox-zip",
  };
}

/**
 * Export the session workspace as a zip.
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
