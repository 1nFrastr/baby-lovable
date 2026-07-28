import { readGitRepository } from "./repository-store";
import { listOpenGitSyncTasks } from "./sync-task-store";
import { isWorkflowRunActive } from "./workflow-run";

const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_MS = 500;

export class CheckpointBarrierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointBarrierError";
  }
}

/**
 * Mutating tools must wait until prior turn checkpoints finish (or fail closed
 * on conflict). Read-only tools may proceed while sync is in flight.
 *
 * Wait-only: never runs commit/push itself. If an open task has no live
 * workflow, CAS-kick at most one durable worker (shared across parallel tools).
 */
export async function awaitPreviousCheckpoint(
  sessionId: string,
  options: {
    userId?: string | null;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const kickedRunIds = new Set<string>();

  while (Date.now() - started < timeoutMs) {
    if (options.signal?.aborted) {
      throw new CheckpointBarrierError("checkpoint wait aborted");
    }

    const repo = await readGitRepository(sessionId, options.userId ?? null);
    if (repo?.syncStatus === "conflict" || repo?.unrecoverable) {
      throw new CheckpointBarrierError(
        repo.syncError ??
          "Source control conflict — file writes are blocked until resolved",
      );
    }
    if (repo?.provisionStatus === "error") {
      throw new CheckpointBarrierError(
        repo.provisionError ?? "Source control provisioning failed",
      );
    }
    if (repo && repo.provisionStatus !== "ready") {
      await sleep(POLL_MS);
      continue;
    }

    const open = await listOpenGitSyncTasks(sessionId, options.userId ?? null);
    const hardError = open.find(
      (task) => task.status === "error" && task.attemptCount >= 5,
    );
    if (hardError) {
      throw new CheckpointBarrierError(
        hardError.lastError ??
          "Previous turn failed to sync to Freestyle — writes blocked",
      );
    }

    const inFlight = open.filter(
      (task) => task.status === "pending" || task.status === "syncing",
    );
    const softErrors = open.filter(
      (task) => task.status === "error" && task.attemptCount < 5,
    );

    if (inFlight.length === 0 && softErrors.length === 0) {
      return;
    }

    // Self-heal dead workers via CAS kick (at most once per runId in this wait).
    for (const task of [...inFlight, ...softErrors]) {
      if (kickedRunIds.has(task.runId)) {
        continue;
      }
      if (await isWorkflowRunActive(task.workflowRunId)) {
        continue;
      }
      kickedRunIds.add(task.runId);
      try {
        const { kickGitTurnCheckpointWorkflow } = await import(
          "@/workflow/git-turn-checkpoint-kick"
        );
        await kickGitTurnCheckpointWorkflow(
          sessionId,
          task.runId,
          options.userId ?? null,
        );
      } catch (error) {
        console.warn(
          `[git] barrier kick failed session=${sessionId} run=${task.runId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }

    await sleep(POLL_MS);
  }

  throw new CheckpointBarrierError(
    `Timed out waiting for previous Freestyle checkpoint (${timeoutMs}ms)`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
