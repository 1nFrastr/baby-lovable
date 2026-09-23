import type { ProjectSandbox } from "@/lib/sandbox/types";

import { commitWorkspaceViaFreestyleApi } from "./commit-workspace";
import { isNonFastForwardError, isZeroIdRefError } from "./empty-remote-error";
import {
  getFreestyleAdapter,
  type FreestyleGitCredentials,
} from "./freestyle-client";
import { redactSecrets } from "./provision-repo";
import { readGitRepository, updateGitRepositoryWithRetry } from "./repository-store";
import {
  enqueueGitSyncTask,
  listOpenGitSyncTasks,
  readGitSyncTask,
  updateGitSyncTaskWithRetry,
} from "./sync-task-store";
import type { GitTurnOutcome, SessionGitSyncTask } from "./types";

const MAX_SYNC_ATTEMPTS = 5;
const LEASE_TTL_MS = 60_000;

export async function enqueueTurnCheckpoint(input: {
  sessionId: string;
  runId: string;
  outcome: GitTurnOutcome;
  commitMessage: string;
  userId?: string | null;
}): Promise<SessionGitSyncTask> {
  const task = await enqueueGitSyncTask(input);

  await updateGitRepositoryWithRetry(
    input.sessionId,
    () => ({
      syncStatus: "queued",
      syncError: null,
    }),
    input.userId,
  );

  return task;
}

/**
 * Claim + execute one sync task: status → add/commit (if needed) → push.
 * Safe to retry: if localCommitSha already set, only re-push.
 */
export async function runTurnCheckpoint(
  sessionId: string,
  runId: string,
  project: ProjectSandbox,
  userId: string | null = null,
  leaseOwner: string = `sync_${Date.now()}`,
): Promise<SessionGitSyncTask> {
  const repo = await readGitRepository(sessionId, userId);
  if (!repo?.repoId || !repo.remoteUrl || !repo.identityId) {
    throw new Error("Freestyle repository not provisioned");
  }
  if (repo.unrecoverable) {
    throw new Error(repo.syncError ?? "source control unrecoverable — writes blocked");
  }

  const git = project.git;
  if (!git) {
    throw new Error("Sandbox missing git runner");
  }

  let task = await readGitSyncTask(sessionId, runId, userId);
  if (!task) {
    throw new Error(`sync task not found: ${runId}`);
  }

  if (
    task.status === "synced" ||
    task.status === "no_changes"
  ) {
    return task;
  }

  if (task.attemptCount >= MAX_SYNC_ATTEMPTS) {
    return updateGitSyncTaskWithRetry(
      sessionId,
      runId,
      () => ({
        status: "error",
        lastError: task?.lastError ?? "retry exhausted",
      }),
      userId,
    );
  }

  const leaseExpiresAt = new Date(Date.now() + LEASE_TTL_MS).toISOString();
  task = await updateGitSyncTaskWithRetry(
    sessionId,
    runId,
    (current) => {
      if (current.status === "synced" || current.status === "no_changes") {
        return null;
      }
      const leaseValid =
        current.leaseOwner &&
        current.leaseExpiresAt &&
        Date.parse(current.leaseExpiresAt) > Date.now() &&
        current.leaseOwner !== leaseOwner;
      if (leaseValid) {
        return null;
      }
      return {
        status: "syncing",
        attemptCount: current.attemptCount + 1,
        leaseOwner,
        leaseExpiresAt,
        lastError: null,
      };
    },
    userId,
  );

  if (task.status !== "syncing" || task.leaseOwner !== leaseOwner) {
    return task;
  }

  await updateGitRepositoryWithRetry(
    sessionId,
    () => ({ syncStatus: "syncing", syncError: null }),
    userId,
  );

  try {
    await git.configureAuthor();
    await git.ensureRemote(repo.remoteUrl);

    let localSha = task.localCommitSha;

    if (!localSha) {
      const hasChanges = await git.hasChanges();
      if (hasChanges) {
        const commit = await git.commit(task.commitMessage, false);
        if (!commit.committed || !commit.sha) {
          throw new Error(commit.skippedReason ?? "commit failed");
        }
        localSha = commit.sha;
        task = await updateGitSyncTaskWithRetry(
          sessionId,
          runId,
          () => ({ localCommitSha: localSha }),
          userId,
        );
      } else {
        // Clean tree: recover half-success (commit landed but sha never persisted)
        // by comparing HEAD to remoteHeadSha — equal ⇒ truly no_changes.
        const headSha = await git.getHeadSha();
        if (!headSha || headSha === repo.remoteHeadSha) {
          const done = await updateGitSyncTaskWithRetry(
            sessionId,
            runId,
            () => ({
              status: "no_changes",
              leaseOwner: null,
              leaseExpiresAt: null,
            }),
            userId,
          );
          await updateGitRepositoryWithRetry(
            sessionId,
            () => ({
              syncStatus: "synced",
              syncError: null,
              lastSyncedRunId: runId,
            }),
            userId,
          );
          return done;
        }

        localSha = headSha;
        task = await updateGitSyncTaskWithRetry(
          sessionId,
          runId,
          () => ({ localCommitSha: localSha }),
          userId,
        );
      }
    }

    const credentials = await getFreestyleAdapter().issueWriteToken(
      repo.identityId,
    );
    const branch = repo.defaultBranch || "main";

    try {
      await git.push(credentials, branch);
    } catch (pushError) {
      if (isNonFastForwardError(pushError)) {
        console.warn(
          `[git] non-fast-forward session=${sessionId} run=${runId}; replaying sandbox tree onto Freestyle main`,
        );
        localSha = await recoverNonFastForwardPush({
          project,
          credentials,
          branch,
          commitMessage: task.commitMessage,
          repoId: repo.repoId,
          remoteUrl: repo.remoteUrl,
          identityId: repo.identityId,
        });
      } else if (
        isZeroIdRefError(pushError) &&
        repo.repoId &&
        repo.remoteUrl &&
        repo.identityId
      ) {
        console.warn(
          `[git] Daytona push hit empty-remote zero-id; falling back to Freestyle Commits API session=${sessionId} run=${runId}`,
        );
        localSha = await commitWorkspaceViaFreestyleApi(project, {
          repoId: repo.repoId,
          remoteUrl: repo.remoteUrl,
          identityId: repo.identityId,
          branch,
          message: task.commitMessage,
        });
      } else {
        throw pushError;
      }
    }

    const done = await updateGitSyncTaskWithRetry(
      sessionId,
      runId,
      () => ({
        status: "synced",
        localCommitSha: localSha,
        remoteSha: localSha,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
      }),
      userId,
    );

    await updateGitRepositoryWithRetry(
      sessionId,
      () => ({
        syncStatus: "synced",
        syncError: null,
        remoteHeadSha: localSha,
        lastSyncedRunId: runId,
      }),
      userId,
    );

    return done;
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
    const failed = await updateGitSyncTaskWithRetry(
      sessionId,
      runId,
      (current) => ({
        status: current.attemptCount >= MAX_SYNC_ATTEMPTS ? "error" : "error",
        lastError: message,
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
      userId,
    );
    await updateGitRepositoryWithRetry(
      sessionId,
      () => ({
        syncStatus: "error",
        syncError: message,
      }),
      userId,
    );
    return failed;
  }
}

/** Flush all open sync tasks before sandbox deletion. */
export async function flushPendingCheckpoints(
  sessionId: string,
  project: ProjectSandbox,
  userId: string | null = null,
): Promise<void> {
  const open = await listOpenGitSyncTasks(sessionId, userId);
  for (const task of open) {
    let result = null as Awaited<ReturnType<typeof runTurnCheckpoint>> | null;

    try {
      const { kickGitTurnCheckpointWorkflow, waitForGitSyncTask } = await import(
        "@/workflow/git-turn-checkpoint-kick"
      );
      await kickGitTurnCheckpointWorkflow(sessionId, task.runId, userId);
      result = await waitForGitSyncTask(sessionId, task.runId, {
        userId,
        timeoutMs: 180_000,
      });
    } catch (workflowError) {
      console.warn(
        `[git] flush via workflow failed session=${sessionId} run=${task.runId}, falling back to inline:`,
        workflowError instanceof Error
          ? workflowError.message
          : workflowError,
      );
      result = await runTurnCheckpoint(
        sessionId,
        task.runId,
        project,
        userId,
        `flush_${task.runId}`,
      );
    }

    if (
      !result ||
      result.status === "error" ||
      result.status === "conflict"
    ) {
      throw new Error(
        `Cannot delete sandbox: checkpoint ${task.runId} is ${result?.status ?? "missing"}: ${result?.lastError ?? ""}`,
      );
    }
  }
}

async function recoverNonFastForwardPush(input: {
  project: ProjectSandbox;
  credentials: FreestyleGitCredentials;
  branch: string;
  commitMessage: string;
  repoId: string;
  remoteUrl: string;
  identityId: string;
}): Promise<string> {
  const git = input.project.git;
  if (git?.replayLocalOntoRemote) {
    try {
      await git.replayLocalOntoRemote(input.credentials, input.branch);
      const commit = await git.commit(input.commitMessage, false);
      const sha =
        (commit.committed ? commit.sha : null) ?? (await git.getHeadSha());
      await git.push(input.credentials, input.branch);
      if (!sha) {
        throw new Error("replay onto remote succeeded but HEAD SHA is missing");
      }
      return sha;
    } catch (error) {
      console.warn(
        `[git] replay onto remote failed, falling back to Freestyle Commits API:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return commitWorkspaceViaFreestyleApi(input.project, {
    repoId: input.repoId,
    remoteUrl: input.remoteUrl,
    identityId: input.identityId,
    branch: input.branch,
    message: input.commitMessage,
  });
}
