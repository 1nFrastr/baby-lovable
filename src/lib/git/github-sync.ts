import {
  buildGithubAppInstallUrl,
  getGithubAppInstallation,
  getGithubInstallationRepository,
  getGithubInstallationSettingsUrl,
  GithubAppError,
  isGithubAppInstallMissingError,
  listGithubInstallationRepositories,
  type GithubInstallationRepository,
} from "@/lib/github/app-client";
import { isGithubAppConfigured } from "@/lib/github/app-config";
import type { GithubAppInstallationBinding } from "@/lib/github/installation-binding";
import {
  deleteGithubAppInstallationBinding,
  readGithubAppInstallationBinding,
} from "@/lib/github/installation-binding-store";
import type { GithubAuthIdentity } from "@/lib/session/auth-context";

import { getFreestyleAdapter } from "./freestyle-client";
import { redactSecrets } from "./provision-repo";
import {
  readGitRepository,
  updateGitRepositoryWithRetry,
} from "./repository-store";
import type {
  GithubSyncStatus,
  SessionGitRepository,
} from "./types";

export class GithubSyncError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "GithubSyncError";
    this.status = status;
  }
}

/** `owner/repo` — GitHub name rules (simplified). */
const GITHUB_REPO_NAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}\/[a-zA-Z0-9._-]{1,100}$/;

export function normalizeGithubRepoName(raw: string): string {
  const trimmed = raw.trim().replace(/^https?:\/\/github\.com\//i, "");
  const withoutGit = trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!GITHUB_REPO_NAME_RE.test(withoutGit)) {
    throw new GithubSyncError("GitHub 返回了无效的仓库名称");
  }
  return withoutGit;
}

export interface GithubSyncStatusPayload {
  linked: boolean;
  githubRepoName: string | null;
  githubSyncStatus: GithubSyncStatus;
  githubSyncError: string | null;
  freestyleReady: boolean;
  installed: boolean;
  githubLogin: string | null;
  installUrl: string | null;
  configureUrl: string | null;
  githubIdentityRequired: boolean;
}

function assertRepoReadyForGithubSync(
  repo: SessionGitRepository | null,
): SessionGitRepository {
  if (!repo?.repoId) {
    throw new GithubSyncError("代码库尚未就绪，请稍后再试", 409);
  }
  if (repo.provisionStatus !== "ready") {
    throw new GithubSyncError(
      repo.provisionError ?? "代码库尚未就绪，请稍后再试",
      409,
    );
  }
  return repo;
}

function assertBindingMatchesIdentity(
  binding: GithubAppInstallationBinding,
  userId: string | null,
  githubIdentity: GithubAuthIdentity | null,
): void {
  if (userId && !githubIdentity) {
    throw new GithubSyncError("请使用 GitHub 账号登录后再连接仓库", 401);
  }
  if (
    githubIdentity &&
    binding.githubAccountId !== githubIdentity.id
  ) {
    throw new GithubSyncError(
      "GitHub App installation 不属于当前登录账号",
      403,
    );
  }
}

async function verifyGithubInstallation(
  userId: string | null,
  githubIdentity: GithubAuthIdentity | null,
): Promise<{
  binding: GithubAppInstallationBinding;
  installationId: number;
}> {
  const binding = await readGithubAppInstallationBinding(userId);
  if (!binding) {
    throw new GithubSyncError("请先安装 GitHub App 并选择仓库", 401);
  }
  assertBindingMatchesIdentity(binding, userId, githubIdentity);

  try {
    const installation = await getGithubAppInstallation(binding.installationId);
    if (
      installation.suspended ||
      installation.accountType !== "User" ||
      installation.accountId !== binding.githubAccountId
    ) {
      await deleteGithubAppInstallationBinding(userId).catch(() => undefined);
      throw new GithubSyncError(
        installation.suspended
          ? "GitHub App installation 已暂停"
          : "GitHub App installation 归属已变化，请重新安装",
        401,
      );
    }
    return { binding, installationId: installation.id };
  } catch (error) {
    if (error instanceof GithubSyncError) {
      throw error;
    }
    if (isGithubAppInstallMissingError(error)) {
      await deleteGithubAppInstallationBinding(userId).catch(() => undefined);
      throw new GithubSyncError(
        "GitHub App 已卸载或不可访问，请重新安装",
        401,
      );
    }
    throw new GithubSyncError(
      redactSecrets(
        error instanceof Error ? error.message : "GitHub installation 验证失败",
      ),
      error instanceof GithubAppError ? error.status : 502,
    );
  }
}

async function resolveInstallationStatus(
  userId: string | null,
  githubIdentity: GithubAuthIdentity | null,
): Promise<{
  installed: boolean;
  githubLogin: string | null;
  installationId: number | null;
}> {
  const binding = await readGithubAppInstallationBinding(userId).catch(
    () => null,
  );
  if (!binding) {
    return { installed: false, githubLogin: null, installationId: null };
  }
  try {
    assertBindingMatchesIdentity(binding, userId, githubIdentity);
    const installation = await getGithubAppInstallation(binding.installationId);
    if (
      installation.suspended ||
      installation.accountType !== "User" ||
      installation.accountId !== binding.githubAccountId
    ) {
      await deleteGithubAppInstallationBinding(userId).catch(() => undefined);
      return {
        installed: false,
        githubLogin: binding.githubLogin,
        installationId: null,
      };
    }
    return {
      installed: true,
      githubLogin: installation.accountLogin,
      installationId: installation.id,
    };
  } catch (error) {
    if (
      error instanceof GithubSyncError ||
      isGithubAppInstallMissingError(error)
    ) {
      await deleteGithubAppInstallationBinding(userId).catch(() => undefined);
      return {
        installed: false,
        githubLogin: binding.githubLogin,
        installationId: null,
      };
    }
    // A transient GitHub failure must not make a valid installation disappear.
    return {
      installed: true,
      githubLogin: binding.githubLogin,
      installationId: binding.installationId,
    };
  }
}

export async function getGithubSyncStatus(
  sessionId: string,
  userId: string | null = null,
  options: {
    reconcile?: boolean;
    githubIdentity?: GithubAuthIdentity | null;
  } = {},
): Promise<GithubSyncStatusPayload> {
  const repo = await readGitRepository(sessionId, userId);
  const githubIdentity = options.githubIdentity ?? null;
  const installation = await resolveInstallationStatus(userId, githubIdentity);
  const githubIdentityRequired = Boolean(userId && !githubIdentity);

  let installUrl: string | null = null;
  if (isGithubAppConfigured() && !githubIdentityRequired) {
    try {
      installUrl = buildGithubAppInstallUrl({
        sessionId,
        userId,
        returnTo: `/sessions/${sessionId}`,
      });
    } catch {
      installUrl = null;
    }
  }
  const configureUrl = installation.installationId
    ? getGithubInstallationSettingsUrl(installation.installationId)
    : null;

  if (!repo?.repoId) {
    return {
      linked: false,
      githubRepoName: null,
      githubSyncStatus: "idle",
      githubSyncError: null,
      freestyleReady: false,
      installed: installation.installed,
      githubLogin: installation.githubLogin,
      installUrl,
      configureUrl,
      githubIdentityRequired,
    };
  }

  let githubRepoName = repo.githubRepoName;
  let githubSyncStatus = repo.githubSyncStatus;
  let githubSyncError = repo.githubSyncError;

  if (options.reconcile && repo.provisionStatus === "ready") {
    try {
      const remote = await getFreestyleAdapter().getGithubSync(repo.repoId);
      if (remote?.githubRepoName) {
        githubRepoName = remote.githubRepoName;
        githubSyncStatus = "linked";
        githubSyncError = null;
        if (
          repo.githubRepoName !== remote.githubRepoName ||
          repo.githubSyncStatus !== "linked"
        ) {
          await updateGitRepositoryWithRetry(
            sessionId,
            () => ({
              githubRepoName: remote.githubRepoName,
              githubSyncStatus: "linked" as const,
              githubSyncError: null,
            }),
            userId,
          );
        }
      } else if (repo.githubSyncStatus === "linked") {
        githubRepoName = null;
        githubSyncStatus = "idle";
        githubSyncError = null;
        await updateGitRepositoryWithRetry(
          sessionId,
          () => ({
            githubRepoName: null,
            githubSyncStatus: "idle" as const,
            githubSyncError: null,
          }),
          userId,
        );
      }
    } catch {
      // Best-effort reconcile — return stored state.
    }
  }

  return {
    linked: githubSyncStatus === "linked" && Boolean(githubRepoName),
    githubRepoName,
    githubSyncStatus,
    githubSyncError,
    freestyleReady: repo.provisionStatus === "ready",
    installed: installation.installed,
    githubLogin: installation.githubLogin,
    installUrl,
    configureUrl,
    githubIdentityRequired,
  };
}

export async function listAvailableGithubRepositories(
  userId: string | null,
  githubIdentity: GithubAuthIdentity | null,
  lastGithubRepositoryId: number | null = null,
): Promise<GithubInstallationRepository[]> {
  const { installationId } = await verifyGithubInstallation(
    userId,
    githubIdentity,
  );
  try {
    const repositories =
      await listGithubInstallationRepositories(installationId);
    return repositories.filter(
      (repository) =>
        repository.size === 0 || repository.id === lastGithubRepositoryId,
    );
  } catch (error) {
    if (isGithubAppInstallMissingError(error)) {
      await deleteGithubAppInstallationBinding(userId).catch(() => undefined);
      throw new GithubSyncError(
        "GitHub App 已卸载或仓库权限已失效，请重新安装",
        401,
      );
    }
    throw new GithubSyncError(
      redactSecrets(
        error instanceof Error ? error.message : "加载 GitHub 仓库失败",
      ),
      error instanceof GithubAppError ? error.status : 502,
    );
  }
}

async function enableGithubRepoSync(
  sessionId: string,
  githubRepositoryId: number,
  githubRepoNameRaw: string,
  userId: string | null,
): Promise<SessionGitRepository> {
  const githubRepoName = normalizeGithubRepoName(githubRepoNameRaw);
  const repo = assertRepoReadyForGithubSync(
    await readGitRepository(sessionId, userId),
  );
  try {
    await getFreestyleAdapter().enableGithubSync(repo.repoId!, githubRepoName);
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : "GitHub Sync enable failed",
    );
    await updateGitRepositoryWithRetry(
      sessionId,
      () => ({
        githubSyncStatus: "error" as const,
        githubSyncError: message,
      }),
      userId,
    );
    throw new GithubSyncError(message, 502);
  }
  return updateGitRepositoryWithRetry(
    sessionId,
    () => ({
      githubRepoName,
      lastGithubRepositoryId: githubRepositoryId,
      githubSyncStatus: "linked" as const,
      githubSyncError: null,
    }),
    userId,
  );
}

export async function linkSelectedGithubRepository(
  sessionId: string,
  repositoryId: number,
  userId: string | null,
  githubIdentity: GithubAuthIdentity | null,
): Promise<SessionGitRepository> {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new GithubSyncError("请选择有效的 GitHub 仓库");
  }
  assertRepoReadyForGithubSync(await readGitRepository(sessionId, userId));
  const { binding, installationId } = await verifyGithubInstallation(
    userId,
    githubIdentity,
  );

  let selected: GithubInstallationRepository;
  try {
    selected = await getGithubInstallationRepository(
      installationId,
      repositoryId,
    );
  } catch (error) {
    if (
      error instanceof GithubAppError &&
      (error.status === 403 ||
        error.status === 404 ||
        error.status === 422)
    ) {
      throw new GithubSyncError(
        "所选仓库不在当前 GitHub App installation 的授权范围内",
        403,
      );
    }
    throw new GithubSyncError(
      redactSecrets(
        error instanceof Error ? error.message : "GitHub 仓库校验失败",
      ),
      502,
    );
  }
  if (
    selected.ownerLogin.toLowerCase() !== binding.githubLogin.toLowerCase()
  ) {
    throw new GithubSyncError("当前仅支持个人账号名下的 GitHub 仓库", 403);
  }
  return enableGithubRepoSync(
    sessionId,
    selected.id,
    selected.fullName,
    userId,
  );
}

export async function unlinkGithubRepo(
  sessionId: string,
  userId: string | null = null,
): Promise<SessionGitRepository> {
  const repo = assertRepoReadyForGithubSync(
    await readGitRepository(sessionId, userId),
  );
  try {
    await getFreestyleAdapter().disableGithubSync(repo.repoId!);
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error ? error.message : "GitHub Sync disable failed",
    );
    await updateGitRepositoryWithRetry(
      sessionId,
      () => ({
        githubSyncStatus: "error" as const,
        githubSyncError: message,
      }),
      userId,
    );
    throw new GithubSyncError(message, 502);
  }
  return updateGitRepositoryWithRetry(
    sessionId,
    () => ({
      githubRepoName: null,
      githubSyncStatus: "idle" as const,
      githubSyncError: null,
    }),
    userId,
  );
}
