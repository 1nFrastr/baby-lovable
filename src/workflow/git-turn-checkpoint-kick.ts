import { start } from "workflow/api";

import {
  readGitSyncTask,
  updateGitSyncTaskWithRetry,
} from "@/lib/git/sync-task-store";
import { runTurnCheckpoint } from "@/lib/git/turn-sync";
import type { SessionGitSyncTask } from "@/lib/git/types";
import {
  isWorkflowRunActive,
  newClaimToken,
} from "@/lib/git/workflow-run";

import { gitTurnCheckpointWorkflow } from "./git-turn-checkpoint";

const TERMINAL_TASK_STATUSES = new Set([
  "synced",
  "no_changes",
  "conflict",
]);

/**
 * CAS-claim + start checkpoint workflow. Parallel waiters share one run.
 * Lives outside the workflow file so Node helpers are not sandboxed.
 */
export async function kickGitTurnCheckpointWorkflow(
  sessionId: string,
  runId: string,
  userId: string | null = null,
): Promise<string | null> {
  const task = await readGitSyncTask(sessionId, runId, userId);
  if (!task) {
    throw new Error(`sync task not found: ${runId}`);
  }
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return task.workflowRunId;
  }
  // Hard error — do not restart.
  if (task.status === "error" && task.attemptCount >= 5) {
    return task.workflowRunId;
  }

  if (task.workflowRunId && (await isWorkflowRunActive(task.workflowRunId))) {
    return task.workflowRunId;
  }

  const observedId = task.workflowRunId;
  const claimToken = newClaimToken();

  const claimed = await updateGitSyncTaskWithRetry(
    sessionId,
    runId,
    (current) => {
      if (TERMINAL_TASK_STATUSES.has(current.status)) {
        return null;
      }
      if (current.status === "error" && current.attemptCount >= 5) {
        return null;
      }
      if (current.workflowRunId !== observedId) {
        return null;
      }
      return { workflowRunId: claimToken };
    },
    userId,
  );

  if (claimed.workflowRunId !== claimToken) {
    return claimed.workflowRunId;
  }

  try {
    const run = await start(gitTurnCheckpointWorkflow, [
      sessionId,
      runId,
      userId,
    ]);
    await updateGitSyncTaskWithRetry(
      sessionId,
      runId,
      (current) => {
        if (current.workflowRunId !== claimToken) {
          return null;
        }
        return { workflowRunId: run.runId };
      },
      userId,
    );
    return run.runId;
  } catch (error) {
    console.warn(
      `[git] checkpoint workflow start failed session=${sessionId} run=${runId}:`,
      error instanceof Error ? error.message : error,
    );
    // Keep claim token while inline runs so parallel waiters do not re-kick.
    void (async () => {
      try {
        await runCheckpointInline(sessionId, runId, userId);
      } finally {
        await updateGitSyncTaskWithRetry(
          sessionId,
          runId,
          (current) => {
            if (current.workflowRunId !== claimToken) {
              return null;
            }
            return { workflowRunId: null };
          },
          userId,
        ).catch(() => undefined);
      }
    })();
    return claimToken;
  }
}

async function runCheckpointInline(
  sessionId: string,
  runId: string,
  userId: string | null,
): Promise<void> {
  try {
    const { getOrCreateDaytonaSandbox } = await import(
      "@/lib/sandbox/daytona/sandbox"
    );
    const project = await getOrCreateDaytonaSandbox(sessionId);
    await runTurnCheckpoint(sessionId, runId, project, userId);
  } catch (error) {
    console.warn(
      `[git] inline checkpoint failed session=${sessionId} run=${runId}:`,
      error instanceof Error ? error.message : error,
    );
  }
}

const WAIT_POLL_MS = 500;

/** Poll until the sync task leaves open statuses (or timeout). */
export async function waitForGitSyncTask(
  sessionId: string,
  runId: string,
  options: {
    userId?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<SessionGitSyncTask> {
  const timeoutMs = options.timeoutMs ?? 180_000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = await readGitSyncTask(
      sessionId,
      runId,
      options.userId ?? null,
    );
    if (!task) {
      throw new Error(`sync task not found: ${runId}`);
    }
    if (
      TERMINAL_TASK_STATUSES.has(task.status) ||
      (task.status === "error" && task.attemptCount >= 5)
    ) {
      return task;
    }
    // Soft error with no live worker — kick once then keep waiting.
    if (
      (task.status === "pending" ||
        task.status === "syncing" ||
        task.status === "error") &&
      !(await isWorkflowRunActive(task.workflowRunId))
    ) {
      await kickGitTurnCheckpointWorkflow(
        sessionId,
        runId,
        options.userId ?? null,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
  throw new Error(
    `Timed out waiting for git sync task ${runId} (${timeoutMs}ms)`,
  );
}
