import {
  buildGithubAppAuthorizeUrl,
  createEmptyUserRepo,
  GithubAppError,
  isGithubAppInstallMissingError,
} from "@/lib/github/app-client";
import { isGithubAppConfigured } from "@/lib/github/app-config";
import { isGithubAccessTokenExpired } from "@/lib/github/user-binding";
import {
  deleteGithubAppUserBinding,
  readGithubAppUserBinding,
  verifyGithubAppUserBinding,
} from "@/lib/github/user-binding-store";

import { getFreestyleAdapter } from "./freestyle-client";
import { getGithubAppInstallUrl } from "./freestyle-config";
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
  readonly authUrl: string | null;

  constructor(
    message: string,
    status = 400,
    options: { authUrl?: string | null } = {},
  ) {
    super(message);
    this.name = "GithubSyncError";
    this.status = status;
    this.authUrl = options.authUrl ?? null;
  }
}

/** `owner/repo` — GitHub name rules (simplified). */
const GITHUB_REPO_NAME_RE =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}\/[a-zA-Z0-9._-]{1,100}$/;

export function normalizeGithubRepoName(raw: string): string {
  const trimmed = raw.trim().replace(/^https?:\/\/github\.com\//i, "");
  const withoutGit = trimmed.replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!GITHUB_REPO_NAME_RE.test(withoutGit)) {
    throw new GithubSyncError(
      "仓库格式无效，请使用 owner/repo（如 acme/my-app）",
    );
  }
  return withoutGit;
}

export function suggestedGithubRepoName(sessionId: string): string {
  const short = sessionId.replace(/^sess_/, "").slice(0, 10);
  return `baby-lovable-${short || "app"}`;
}

export interface GithubSyncStatusPayload {
  linked: boolean;
  githubRepoName: string | null;
  githubSyncStatus: GithubSyncStatus;
  githubSyncError: string | null;
  installUrl: string | null;
  freestyleReady: boolean;
  /** User has a stored GitHub App binding with a usable (or refreshable) token. */
  authorized: boolean;
  githubLogin: string | null;
  /** Present when App OAuth is configured and user is not authorized. */
  authUrl: string | null;
  suggestedRepoName: string;
  createAndLinkAvailable: boolean;
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

export function buildGithubSyncAuthUrl(input: {
  sessionId: string;
  userId: string;
  requestOrigin?: string;
  returnTo?: string;
}): string {
  try {
    return buildGithubAppAuthorizeUrl(input);
  } catch (error) {
    if (error instanceof GithubAppError) {
      throw new GithubSyncError(error.message, error.status);
    }
    throw error;
  }
}

async function resolveAuthorizedFlag(
  userId: string | null,
  options: { probeInstall?: boolean } = {},
): Promise<{ authorized: boolean; githubLogin: string | null }> {
  if (!userId) {
    return { authorized: false, githubLogin: null };
  }
  try {
    if (options.probeInstall) {
      try {
        const verified = await verifyGithubAppUserBinding(userId);
        return {
          authorized: true,
          githubLogin: verified.binding.githubLogin,
        };
      } catch (error) {
        if (
          error instanceof GithubAppError &&
          (error.status === 401 || isGithubAppInstallMissingError(error))
        ) {
          const binding = await readGithubAppUserBinding(userId).catch(
            () => null,
          );
          return {
            authorized: false,
            githubLogin: binding?.githubLogin ?? null,
          };
        }
        // Probe failed for transient reasons — fall back to stored flag.
      }
    }

    const binding = await readGithubAppUserBinding(userId);
    if (!binding) {
      return { authorized: false, githubLogin: null };
    }
    const expired = isGithubAccessTokenExpired(binding);
    if (expired && !binding.refreshToken) {
      return { authorized: false, githubLogin: binding.githubLogin };
    }
    return { authorized: true, githubLogin: binding.githubLogin };
  } catch {
    // Binding store may be unavailable (e.g. migration not applied yet).
    return { authorized: false, githubLogin: null };
  }
}

export async function getGithubSyncStatus(
  sessionId: string,
  userId: string | null = null,
  options: { reconcile?: boolean; requestOrigin?: string } = {},
): Promise<GithubSyncStatusPayload> {
  const installUrl = getGithubAppInstallUrl();
  const repo = await readGitRepository(sessionId, userId);
  const { authorized, githubLogin } = await resolveAuthorizedFlag(userId, {
    // Status reads are infrequent; probe so uninstall is noticed without a webhook.
    probeInstall: Boolean(userId),
  });
  const createAndLinkAvailable = isGithubAppConfigured();
  const suggestedRepoName = suggestedGithubRepoName(sessionId);

  let authUrl: string | null = null;
  if (createAndLinkAvailable && userId && !authorized) {
    try {
      authUrl = buildGithubSyncAuthUrl({
        sessionId,
        userId,
        requestOrigin: options.requestOrigin,
      });
    } catch {
      authUrl = null;
    }
  }

  if (!repo?.repoId) {
    return {
      linked: false,
      githubRepoName: null,
      githubSyncStatus: "idle",
      githubSyncError: null,
      installUrl,
      freestyleReady: false,
      authorized,
      githubLogin,
      authUrl,
      suggestedRepoName,
      createAndLinkAvailable,
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
    installUrl,
    freestyleReady: repo.provisionStatus === "ready",
    authorized,
    githubLogin,
    authUrl,
    suggestedRepoName,
    createAndLinkAvailable,
  };
}

export async function linkGithubRepo(
  sessionId: string,
  githubRepoNameRaw: string,
  userId: string | null = null,
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
      githubSyncStatus: "linked" as const,
      githubSyncError: null,
    }),
    userId,
  );
}

/**
 * Create a private empty GitHub repo for the user, then enable Freestyle Sync.
 * Requires a stored GitHub App user binding; otherwise throws with `authUrl`.
 */
export async function createAndLinkGithubRepo(
  sessionId: string,
  userId: string | null,
  options: {
    repoName?: string;
    requestOrigin?: string;
    returnTo?: string;
  } = {},
): Promise<SessionGitRepository> {
  if (!userId) {
    throw new GithubSyncError(
      "请先登录后再同步到 GitHub（需要稳定的用户身份保存授权）",
      401,
    );
  }

  if (!isGithubAppConfigured()) {
    throw new GithubSyncError(
      "平台未配置 GitHub App（GITHUB_APP_ID / PRIVATE_KEY / CLIENT_ID / SECRET）",
      503,
    );
  }

  assertRepoReadyForGithubSync(await readGitRepository(sessionId, userId));

  let authUrl: string | null = null;
  try {
    authUrl = buildGithubSyncAuthUrl({
      sessionId,
      userId,
      requestOrigin: options.requestOrigin,
      returnTo: options.returnTo,
    });
  } catch {
    authUrl = null;
  }

  let accessToken: string;
  let githubLogin: string;
  try {
    const resolved = await verifyGithubAppUserBinding(userId);
    accessToken = resolved.token;
    githubLogin = resolved.binding.githubLogin;
  } catch (error) {
    const message =
      error instanceof GithubAppError
        ? error.message
        : "需要先授权安装 GitHub App";
    throw new GithubSyncError(message, 401, { authUrl });
  }

  const baseName =
    options.repoName?.trim() || suggestedGithubRepoName(sessionId);

  let created;
  try {
    created = await createEmptyUserRepo(accessToken, baseName, {
      ownerLogin: githubLogin,
    });
  } catch (error) {
    if (isGithubAppInstallMissingError(error)) {
      await deleteGithubAppUserBinding(userId).catch(() => undefined);
      throw new GithubSyncError(
        error instanceof Error
          ? error.message
          : "GitHub App 已卸载，请重新授权安装",
        401,
        { authUrl },
      );
    }
    const message = redactSecrets(
      error instanceof Error ? error.message : "创建 GitHub 仓库失败",
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

  const fullName = created.fullName || `${githubLogin}/${created.name}`;
  try {
    return await linkGithubRepo(sessionId, fullName, userId);
  } catch (error) {
    // Repo was created; surface Freestyle enable failure with full name.
    if (error instanceof GithubSyncError) {
      throw new GithubSyncError(
        `${error.message}（已创建仓库 ${fullName}，可稍后用「连接已有仓库」重试）`,
        error.status,
      );
    }
    throw error;
  }
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
