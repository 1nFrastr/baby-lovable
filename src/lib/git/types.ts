/** Freestyle / source-control domain types (sidecar — not on Session). */

export type GitProvider = "freestyle";

export type GitProvisionStatus = "preparing" | "ready" | "error";

export type GitSyncStatus =
  | "idle"
  | "queued"
  | "syncing"
  | "synced"
  | "error"
  | "conflict";

export type GitSyncTaskStatus =
  | "pending"
  | "syncing"
  | "synced"
  | "no_changes"
  | "error"
  | "conflict";

export type GitTurnOutcome = "completed" | "failed" | "cancelled";

/** Freestyle ↔ GitHub Sync link state (not turn checkpoint status). */
export type GithubSyncStatus = "idle" | "linked" | "error";

/** Durable Freestyle repo binding for one session. */
export interface SessionGitRepository {
  sessionId: string;
  provider: GitProvider;
  repoId: string | null;
  remoteUrl: string | null;
  defaultBranch: string;
  identityId: string | null;
  provisionStatus: GitProvisionStatus;
  provisionError: string | null;
  remoteHeadSha: string | null;
  lastSyncedRunId: string | null;
  syncStatus: GitSyncStatus;
  syncError: string | null;
  /** Linked GitHub repo as `owner/repo` when Freestyle GitHub Sync is enabled. */
  githubRepoName: string | null;
  /** Last repository successfully linked through Freestyle, retained after unlink. */
  lastGithubRepositoryId: number | null;
  githubSyncStatus: GithubSyncStatus;
  githubSyncError: string | null;
  /** True when sandbox was lost and remote has no recoverable history. */
  unrecoverable: boolean;
  /** Durable Workflow DevKit run id for Freestyle repo provisioning. */
  provisionWorkflowRunId: string | null;
  revision: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  updatedAt: string;
}

/** One turn → one sync task (unique on sessionId + runId). */
export interface SessionGitSyncTask {
  sessionId: string;
  runId: string;
  status: GitSyncTaskStatus;
  outcome: GitTurnOutcome;
  commitMessage: string;
  /** Set after successful commit so push-only retries do not duplicate commits. */
  localCommitSha: string | null;
  remoteSha: string | null;
  attemptCount: number;
  lastError: string | null;
  /** Durable Workflow DevKit run id for this turn's commit/push worker. */
  workflowRunId: string | null;
  revision: number;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Lightweight UI projection for source control. */
export interface SourceControlProjection {
  status:
    | "idle"
    | "preparing"
    | "ready"
    | "syncing"
    | "synced"
    | "error"
    | "conflict";
  shortSha?: string;
  error?: string;
  /** Present when Freestyle GitHub Sync is linked. */
  githubRepoName?: string;
  updatedAt: string;
}

/** Read-only version row for the History panel (no lease / workflow internals). */
export interface VersionHistoryItem {
  runId: string;
  status: GitSyncTaskStatus;
  outcome: GitTurnOutcome;
  commitMessage: string;
  shortSha: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export function emptyGitRepository(
  sessionId: string,
  updatedAt: string = new Date().toISOString(),
): SessionGitRepository {
  return {
    sessionId,
    provider: "freestyle",
    repoId: null,
    remoteUrl: null,
    defaultBranch: "main",
    identityId: null,
    provisionStatus: "preparing",
    provisionError: null,
    remoteHeadSha: null,
    lastSyncedRunId: null,
    syncStatus: "idle",
    syncError: null,
    githubRepoName: null,
    lastGithubRepositoryId: null,
    githubSyncStatus: "idle",
    githubSyncError: null,
    unrecoverable: false,
    provisionWorkflowRunId: null,
    revision: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt,
  };
}

/** Fill fields added after older persisted rows were written. */
export function normalizeGitRepository(
  repo: SessionGitRepository,
): SessionGitRepository {
  return {
    ...repo,
    githubRepoName: repo.githubRepoName ?? null,
    lastGithubRepositoryId: repo.lastGithubRepositoryId ?? null,
    githubSyncStatus: repo.githubSyncStatus ?? "idle",
    githubSyncError: repo.githubSyncError ?? null,
    provisionWorkflowRunId: repo.provisionWorkflowRunId ?? null,
  };
}

export function normalizeGitSyncTask(
  task: SessionGitSyncTask,
): SessionGitSyncTask {
  return {
    ...task,
    workflowRunId: task.workflowRunId ?? null,
  };
}

export function sourceControlFromRepository(
  repo: SessionGitRepository | null,
  updatedAt: string = new Date().toISOString(),
): SourceControlProjection {
  if (!repo) {
    return { status: "idle", updatedAt };
  }

  const githubRepoName =
    repo.githubSyncStatus === "linked" && repo.githubRepoName
      ? repo.githubRepoName
      : undefined;

  if (repo.provisionStatus === "preparing") {
    return {
      status: "preparing",
      githubRepoName,
      updatedAt: repo.updatedAt || updatedAt,
    };
  }
  if (repo.provisionStatus === "error" || repo.unrecoverable) {
    return {
      status: "error",
      error: repo.provisionError ?? repo.syncError ?? "source control error",
      githubRepoName,
      updatedAt: repo.updatedAt || updatedAt,
    };
  }

  const shortSha = repo.remoteHeadSha
    ? repo.remoteHeadSha.slice(0, 7)
    : undefined;

  switch (repo.syncStatus) {
    case "queued":
    case "syncing":
      return {
        status: "syncing",
        shortSha,
        githubRepoName,
        updatedAt: repo.updatedAt || updatedAt,
      };
    case "synced":
      return {
        status: "synced",
        shortSha,
        githubRepoName,
        updatedAt: repo.updatedAt || updatedAt,
      };
    case "conflict":
      return {
        status: "conflict",
        shortSha,
        error: repo.syncError ?? "conflict with remote",
        githubRepoName,
        updatedAt: repo.updatedAt || updatedAt,
      };
    case "error":
      return {
        status: "error",
        shortSha,
        error: repo.syncError ?? "sync failed",
        githubRepoName,
        updatedAt: repo.updatedAt || updatedAt,
      };
    default:
      return {
        status: "ready",
        shortSha,
        githubRepoName,
        updatedAt: repo.updatedAt || updatedAt,
      };
  }
}
