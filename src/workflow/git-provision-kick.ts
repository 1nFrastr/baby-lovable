import { start } from "workflow/api";

import {
  ensureFreestyleRepository,
  markRepositoryProvisionError,
  redactSecrets,
} from "@/lib/git/provision-repo";
import {
  ensureGitRepository,
  readGitRepository,
  updateGitRepositoryWithRetry,
} from "@/lib/git/repository-store";
import {
  isWorkflowRunActive,
  newClaimToken,
} from "@/lib/git/workflow-run";

import { provisionFreestyleRepoWorkflow } from "./git-provision";

/**
 * CAS-claim + start provision workflow. Parallel callers share one run.
 * Returns the workflow run id, or null when already provisioned / kick lost.
 *
 * Lives outside the workflow file so Node store helpers are not bundled
 * into the workflow sandbox.
 */
export async function kickFreestyleProvisionWorkflow(
  sessionId: string,
  userId: string | null = null,
): Promise<string | null> {
  await ensureGitRepository(sessionId, userId);
  const repo = await readGitRepository(sessionId, userId);
  if (repo?.repoId && repo.identityId && repo.remoteUrl) {
    return repo.provisionWorkflowRunId;
  }

  if (
    repo?.provisionWorkflowRunId &&
    (await isWorkflowRunActive(repo.provisionWorkflowRunId))
  ) {
    return repo.provisionWorkflowRunId;
  }

  const observedId = repo?.provisionWorkflowRunId ?? null;
  const claimToken = newClaimToken();

  const claimed = await updateGitRepositoryWithRetry(
    sessionId,
    (current) => {
      if (current.repoId && current.identityId && current.remoteUrl) {
        return null;
      }
      if (current.provisionWorkflowRunId !== observedId) {
        return null;
      }
      return {
        provisionStatus: "preparing",
        provisionError: null,
        provisionWorkflowRunId: claimToken,
      };
    },
    userId,
  );

  if (claimed.provisionWorkflowRunId !== claimToken) {
    return claimed.provisionWorkflowRunId;
  }

  try {
    const run = await start(provisionFreestyleRepoWorkflow, [
      sessionId,
      userId,
    ]);
    await updateGitRepositoryWithRetry(
      sessionId,
      (current) => {
        if (current.provisionWorkflowRunId !== claimToken) {
          return null;
        }
        return { provisionWorkflowRunId: run.runId };
      },
      userId,
    );
    return run.runId;
  } catch (error) {
    console.warn(
      `[git] provision workflow start failed session=${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
    // Fallback for CLI / environments without Workflow world.
    try {
      await ensureFreestyleRepository(sessionId, userId);
    } catch (fallbackError) {
      const message = redactSecrets(
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError),
      );
      await markRepositoryProvisionError(sessionId, message, userId);
    } finally {
      await updateGitRepositoryWithRetry(
        sessionId,
        (current) => {
          if (current.provisionWorkflowRunId !== claimToken) {
            return null;
          }
          return { provisionWorkflowRunId: null };
        },
        userId,
      ).catch(() => undefined);
    }
    return null;
  }
}
