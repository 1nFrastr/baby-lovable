import type { DaytonaProjectSandbox } from "@/lib/sandbox/daytona/provider";

import { getFreestyleAdapter } from "./freestyle-client";
import {
  ensureFreestyleRepository,
  markRepositoryProvisionError,
  markRepositoryReady,
  redactSecrets,
} from "./provision-repo";
import { seedEmptyFreestyleRepo } from "./seed-remote";

export interface HydrateResult {
  ok: boolean;
  remoteHeadSha: string | null;
  mode: "init-push" | "pull" | "already-ready";
  error?: string;
}

function isEmptyRemoteError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    msg.includes("couldn't find remote ref") ||
    msg.includes("could not find remote ref") ||
    msg.includes("no upstream") ||
    msg.includes("doesn't have any refs") ||
    msg.includes("does not have any refs") ||
    msg.includes("empty repository") ||
    msg.includes("remote empty") ||
    msg.includes("git-upload-pack") ||
    msg.includes("connection reset") ||
    msg.includes("repository not found") ||
    msg.includes("illegal zero-id")
  );
}

/**
 * Prepare Daytona workspace from Freestyle `main` using Daytona SDK git.
 *
 * Empty remotes are seeded once via Freestyle Commits API (host), because
 * Daytona SDK cannot push the first commit to an empty Freestyle repo.
 * After that, hydrate uses SDK pull/checkout only.
 */
export async function hydrateWorkspaceFromFreestyle(
  sessionId: string,
  project: DaytonaProjectSandbox,
  userId: string | null = null,
): Promise<HydrateResult> {
  try {
    let repo = await ensureFreestyleRepository(sessionId, userId);
    if (!repo.repoId || !repo.remoteUrl || !repo.identityId) {
      throw new Error("Freestyle repository binding incomplete");
    }
    const remoteUrl = repo.remoteUrl;
    const identityId = repo.identityId;
    const repoId = repo.repoId;

    const git = project.git;
    if (!git) {
      throw new Error("Daytona sandbox missing git runner");
    }

    const credentials = await getFreestyleAdapter().issueWriteToken(identityId);
    const branch = repo.defaultBranch || "main";

    // First bind: seed empty Freestyle repo from host, then pull into sandbox.
    if (!repo.remoteHeadSha) {
      const sha = await seedEmptyFreestyleRepo(repoId);
      const { updateGitRepositoryWithRetry } = await import(
        "./repository-store"
      );
      repo = await updateGitRepositoryWithRetry(
        sessionId,
        () => ({ remoteHeadSha: sha }),
        userId,
      );
    }

    if (!(await git.isRepoInitialized())) {
      await git.initMain();
    } else {
      await git.configureAuthor();
    }

    await git.ensureRemote(remoteUrl);

    try {
      await git.pull(credentials, branch);
      await git.checkoutBranch(branch);
    } catch (pullError) {
      if (!isEmptyRemoteError(pullError)) {
        throw pullError;
      }
      // Remote still empty somehow — seed again then pull.
      if (repoId) {
        const sha = await seedEmptyFreestyleRepo(repoId);
        await git.pull(credentials, branch);
        await git.checkoutBranch(branch);
        await markRepositoryReady(sessionId, sha, userId);
        return { ok: true, remoteHeadSha: sha, mode: "init-push" };
      }
      throw pullError;
    }

    await markRepositoryReady(sessionId, repo.remoteHeadSha, userId);
    return {
      ok: true,
      remoteHeadSha: repo.remoteHeadSha,
      mode: "pull",
    };
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
    await markRepositoryProvisionError(sessionId, message, userId);
    return {
      ok: false,
      remoteHeadSha: null,
      mode: "already-ready",
      error: message,
    };
  }
}
