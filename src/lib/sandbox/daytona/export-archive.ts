import { awaitPreviousCheckpoint } from "@/lib/git/await-checkpoint";
import { getFreestyleAdapter } from "@/lib/git/freestyle-client";
import { isFreestyleConfigured } from "@/lib/git/freestyle-config";
import { readGitRepository } from "@/lib/git/repository-store";
import { getSession } from "@/lib/session/store";
import { NotImplementedError } from "../types";

export type ExportArchiveSource = "freestyle-zip";

export interface ExportArchiveResult {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
  source: ExportArchiveSource;
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

/**
 * Export Freestyle remote tree as a zip (source snapshot at a revision).
 * Does not include `.git` history — Freestyle's archive APIs are contents-only.
 *
 * Waits for in-flight checkpoints first so finished turns are on remote.
 * Mid-turn uncommitted sandbox edits are not included.
 */
async function exportFreestyleArchive(
  sessionId: string,
  title: string | undefined,
  userId: string | null,
): Promise<ExportArchiveResult> {
  if (!isFreestyleConfigured()) {
    throw new Error("FREESTYLE_API_KEY is required for Daytona export");
  }

  await awaitPreviousCheckpoint(sessionId, { userId });

  const repo = await readGitRepository(sessionId, userId);
  if (!repo?.repoId) {
    throw new Error(`Freestyle repository not bound for session ${sessionId}`);
  }
  if (repo.provisionStatus !== "ready") {
    throw new Error(
      repo.provisionError ??
        `Freestyle repository is not ready (status=${repo.provisionStatus})`,
    );
  }
  if (repo.unrecoverable) {
    throw new Error(
      repo.provisionError ??
        "Freestyle repository is unrecoverable — nothing to export",
    );
  }

  const rev = repo.defaultBranch || "main";
  const bytes = await getFreestyleAdapter().downloadRepoZip(repo.repoId, rev);

  return {
    filename: archiveFilename(sessionId, title),
    contentType: "application/zip",
    bytes,
    source: "freestyle-zip",
  };
}

/**
 * Export the session workspace as a Freestyle source zip.
 * Local: not implemented yet — interface reserved.
 */
export async function exportWorkspaceArchive(
  sessionId: string,
  options: { userId?: string | null } = {},
): Promise<ExportArchiveResult> {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  if (session.sandboxMode === "local") {
    throw new NotImplementedError("Local workspace archive export");
  }

  return exportFreestyleArchive(
    sessionId,
    session.title,
    options.userId ?? session.userId ?? null,
  );
}
