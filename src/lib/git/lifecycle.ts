import { getFreestyleAdapter } from "./freestyle-client";
import { getFreestyleRepoRetentionDays } from "./freestyle-config";
import { readGitRepository, updateGitRepositoryWithRetry } from "./repository-store";

/**
 * Soft-deleted sessions keep Freestyle repos until retention elapses.
 * Call from a scheduled GC job — does not run automatically in the request path.
 */
export async function gcExpiredFreestyleRepos(
  candidates: Array<{
    sessionId: string;
    deletedAt: string;
    userId?: string | null;
  }>,
  now: Date = new Date(),
): Promise<{ deleted: string[]; skipped: string[] }> {
  const retentionMs = getFreestyleRepoRetentionDays() * 24 * 60 * 60 * 1000;
  const deleted: string[] = [];
  const skipped: string[] = [];
  const adapter = getFreestyleAdapter();

  for (const candidate of candidates) {
    const deletedAtMs = Date.parse(candidate.deletedAt);
    if (!Number.isFinite(deletedAtMs) || now.getTime() - deletedAtMs < retentionMs) {
      skipped.push(candidate.sessionId);
      continue;
    }

    const repo = await readGitRepository(candidate.sessionId, candidate.userId);
    if (!repo?.repoId) {
      skipped.push(candidate.sessionId);
      continue;
    }

    // Refuse GC while checkpoints are still open — caller should flush first.
    const { hasOpenGitSyncTasks } = await import("./sync-task-store");
    if (await hasOpenGitSyncTasks(candidate.sessionId, candidate.userId)) {
      skipped.push(candidate.sessionId);
      continue;
    }

    await adapter.deleteRepo(repo.repoId);
    await updateGitRepositoryWithRetry(
      candidate.sessionId,
      () => ({
        repoId: null,
        remoteUrl: null,
        identityId: null,
        provisionStatus: "error",
        provisionError: "repository garbage-collected after session retention",
      }),
      candidate.userId,
    );
    deleted.push(candidate.sessionId);
  }

  return { deleted, skipped };
}

/**
 * Migrate an existing Daytona session that predates Freestyle binding.
 * If the sandbox still exists, hydrate/push creates the first remote commit.
 * If sandbox is gone and remote empty → mark unrecoverable (never silent starter).
 */
export async function migrateLegacyDaytonaSession(input: {
  sessionId: string;
  hasLiveSandbox: boolean;
  userId?: string | null;
}): Promise<{ ok: boolean; unrecoverable?: boolean; error?: string }> {
  const { ensureFreestyleRepository, markRepositoryUnrecoverable } = await import(
    "./provision-repo"
  );

  try {
    await ensureFreestyleRepository(input.sessionId, input.userId ?? null);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!input.hasLiveSandbox) {
    const repo = await readGitRepository(input.sessionId, input.userId);
    if (!repo?.remoteHeadSha) {
      await markRepositoryUnrecoverable(
        input.sessionId,
        "Sandbox lost and Freestyle remote has no recoverable history",
        input.userId,
      );
      return { ok: false, unrecoverable: true };
    }
    return { ok: true };
  }

  return { ok: true };
}
