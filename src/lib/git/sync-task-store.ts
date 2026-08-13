import {
  listGitSyncTasksSupabase,
  readGitSyncTaskSupabase,
  writeGitSyncTaskSupabase,
} from "./sync-task-store-supabase";
import {
  normalizeGitSyncTask,
  type GitTurnOutcome,
  type SessionGitSyncTask,
} from "./types";

export interface GitSyncTaskStoreAdapter {
  /** Supabase requires the owning auth user; in-memory unit adapters do not. */
  requiresUserId?: boolean;
  read(sessionId: string, runId: string): Promise<SessionGitSyncTask | null>;
  write(task: SessionGitSyncTask, userId: string | null): Promise<void>;
  list(sessionId: string): Promise<SessionGitSyncTask[]>;
}

const supabaseAdapter: GitSyncTaskStoreAdapter = {
  requiresUserId: true,
  read: readGitSyncTaskSupabase,
  write: writeGitSyncTaskSupabase,
  list: listGitSyncTasksSupabase,
};

let storeAdapter: GitSyncTaskStoreAdapter = supabaseAdapter;

/** Unit tests inject an in-memory adapter; production always uses Supabase. */
export function setGitSyncTaskStoreAdapterForTests(
  adapter: GitSyncTaskStoreAdapter | null,
): void {
  storeAdapter = adapter ?? supabaseAdapter;
}

async function resolveUserId(
  sessionId: string,
  userId: string | null = null,
): Promise<string | null> {
  if (userId) {
    return userId;
  }
  const { getSession } = await import("@/lib/session/store");
  const session = await getSession(sessionId);
  return session?.userId ?? null;
}

export async function readGitSyncTask(
  sessionId: string,
  runId: string,
  userId: string | null = null,
): Promise<SessionGitSyncTask | null> {
  void userId;
  const task = await storeAdapter.read(sessionId, runId);
  return task ? normalizeGitSyncTask(task) : null;
}

export async function writeGitSyncTask(
  task: SessionGitSyncTask,
  userId: string | null = null,
): Promise<void> {
  const ownerId =
    storeAdapter.requiresUserId === false
      ? userId
      : await resolveUserId(task.sessionId, userId);
  await storeAdapter.write(task, ownerId);
}

export async function listGitSyncTasks(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionGitSyncTask[]> {
  void userId;
  const tasks = await storeAdapter.list(sessionId);
  return tasks.map(normalizeGitSyncTask);
}

export class GitSyncTaskCasError extends Error {
  constructor(message = "git sync task CAS conflict") {
    super(message);
    this.name = "GitSyncTaskCasError";
  }
}

/**
 * Idempotent enqueue: one task per sessionId+runId.
 * Replays return the existing task without resetting terminal states.
 */
export async function enqueueGitSyncTask(input: {
  sessionId: string;
  runId: string;
  outcome: GitTurnOutcome;
  commitMessage: string;
  userId?: string | null;
}): Promise<SessionGitSyncTask> {
  const existing = await readGitSyncTask(
    input.sessionId,
    input.runId,
    input.userId,
  );
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const task: SessionGitSyncTask = {
    sessionId: input.sessionId,
    runId: input.runId,
    status: "pending",
    outcome: input.outcome,
    commitMessage: input.commitMessage,
    localCommitSha: null,
    remoteSha: null,
    attemptCount: 0,
    lastError: null,
    workflowRunId: null,
    revision: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await writeGitSyncTask(task, input.userId);
  return task;
}

export async function updateGitSyncTask(
  sessionId: string,
  runId: string,
  expectedRevision: number,
  patch: Partial<SessionGitSyncTask>,
  userId: string | null = null,
): Promise<SessionGitSyncTask> {
  const current = await readGitSyncTask(sessionId, runId, userId);
  if (!current) {
    throw new Error(`git sync task not found: ${sessionId}/${runId}`);
  }
  if (current.revision !== expectedRevision) {
    throw new GitSyncTaskCasError(
      `expected revision ${expectedRevision}, found ${current.revision}`,
    );
  }

  const next: SessionGitSyncTask = {
    ...current,
    ...patch,
    sessionId,
    runId,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  await writeGitSyncTask(next, userId);
  return next;
}

export async function updateGitSyncTaskWithRetry(
  sessionId: string,
  runId: string,
  mutate: (current: SessionGitSyncTask) => Partial<SessionGitSyncTask> | null,
  userId: string | null = null,
  attempts = 5,
): Promise<SessionGitSyncTask> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    const current = await readGitSyncTask(sessionId, runId, userId);
    if (!current) {
      throw new Error(`git sync task not found: ${sessionId}/${runId}`);
    }
    const patch = mutate(current);
    if (!patch) {
      return current;
    }
    try {
      return await updateGitSyncTask(
        sessionId,
        runId,
        current.revision,
        patch,
        userId,
      );
    } catch (error) {
      lastError = error;
      if (!(error instanceof GitSyncTaskCasError)) {
        throw error;
      }
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("git sync task update retry exhausted");
}

const OPEN_STATUSES = new Set(["pending", "syncing", "error"]);

export async function listOpenGitSyncTasks(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionGitSyncTask[]> {
  const tasks = await listGitSyncTasks(sessionId, userId);
  return tasks.filter((task) => OPEN_STATUSES.has(task.status));
}

export async function hasOpenGitSyncTasks(
  sessionId: string,
  userId: string | null = null,
): Promise<boolean> {
  const open = await listOpenGitSyncTasks(sessionId, userId);
  return open.length > 0;
}
