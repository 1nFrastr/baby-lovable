import type { DaytonaProjectSandbox } from "@/lib/sandbox/daytona/provider";

import { getFreestyleAdapter } from "./freestyle-client";
import { isEmptyRemoteGitError } from "./empty-remote-error";
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

/**
 * Prepare Daytona workspace from Freestyle `main` using Daytona SDK git.
 *
 * Freestyle repos are seeded at provision (Commits API) so Daytona never has
 * to git-push the first commit. Hydrate then pull/checkout. An empty-remote
 * pull is retried after a second seed; if Daytona still cannot see `main`,
 * provision fails — writes stay blocked until git is actually ready.
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
      if (!isEmptyRemoteGitError(pullError)) {
        throw pullError;
      }
      const sha = await seedEmptyFreestyleRepo(repoId);
      const { updateGitRepositoryWithRetry } = await import(
        "./repository-store"
      );
      repo = await updateGitRepositoryWithRetry(
        sessionId,
        () => ({ remoteHeadSha: sha }),
        userId,
      );
      await git.pull(credentials, branch);
      await git.checkoutBranch(branch);
      await markRepositoryReady(sessionId, sha, userId);
      return { ok: true, remoteHeadSha: sha, mode: "init-push" };
    }

    const headSha = (await git.getHeadSha()) ?? repo.remoteHeadSha;
    await markRepositoryReady(sessionId, headSha, userId);
    return {
      ok: true,
      remoteHeadSha: headSha,
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
