import { createPrivateKey, createSign } from "node:crypto";

import {
  getGithubAppId,
  getGithubAppInstallUrl,
  getGithubAppPrivateKey,
  getGithubAppSlug,
  isGithubAppConfigured,
} from "./app-config";
import { buildGithubAppInstallState } from "./install-state";

const GITHUB_API_VERSION = "2022-11-28";

export class GithubAppError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "GithubAppError";
    this.status = status;
  }
}

export interface GithubAppInstallation {
  id: number;
  appId: number;
  accountId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected";
  suspended: boolean;
}

export interface GithubInstallationRepository {
  id: number;
  fullName: string;
  name: string;
  ownerLogin: string;
  private: boolean;
  htmlUrl: string;
  createdAt: string;
  size: number;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** GitHub App JWT (RS256), valid for about 10 minutes. */
export function createGithubAppJwt(): string {
  const appId = getGithubAppId();
  const privateKey = getGithubAppPrivateKey();
  if (!appId || !privateKey) {
    throw new GithubAppError("GitHub App credentials are not configured", 503);
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - 60,
    exp: now + 9 * 60,
    iss: appId,
  };
  const data = `${base64urlJson(header)}.${base64urlJson(payload)}`;
  const signer = createSign("RSA-SHA256");
  signer.update(data);
  signer.end();
  const signature = signer.sign(createPrivateKey(privateKey));
  return `${data}.${signature.toString("base64url")}`;
}

function formatGithubApiError(
  data: {
    message?: string;
    errors?: Array<{ message?: string; code?: string; field?: string }>;
  } | null,
  path: string,
  status: number,
): string {
  const detail = Array.isArray(data?.errors)
    ? data.errors
        .map((entry) => entry.message)
        .filter((message): message is string => Boolean(message))
        .join("; ")
    : "";
  const head = data?.message?.trim();
  if (head && detail) {
    return `${head} (${detail})`;
  }
  return head || detail || `GitHub API ${path} failed (${status})`;
}

async function githubApi<T>(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      ...(init?.headers ?? {}),
    },
  });
  const data = (await response.json().catch(() => null)) as
    | (T & {
        message?: string;
        errors?: Array<{ message?: string; code?: string; field?: string }>;
      })
    | null;
  if (!response.ok) {
    const status = [401, 403, 404, 409, 422].includes(response.status)
      ? response.status
      : 502;
    throw new GithubAppError(
      formatGithubApiError(data, path, response.status),
      status,
    );
  }
  return data as T;
}

export async function getInstallationAccessToken(
  installationId: number,
  options: { repositoryIds?: number[] } = {},
): Promise<string> {
  const jwt = createGithubAppJwt();
  const body =
    options.repositoryIds && options.repositoryIds.length > 0
      ? JSON.stringify({ repository_ids: options.repositoryIds })
      : undefined;
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body } : {}),
    },
  );
  const data = (await response.json().catch(() => null)) as {
    token?: string;
    message?: string;
    errors?: Array<{ message?: string; code?: string; field?: string }>;
  } | null;
  if (!response.ok || !data?.token) {
    const status =
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 422
        ? response.status
        : 502;
    throw new GithubAppError(
      formatGithubApiError(
        data,
        `/app/installations/${installationId}/access_tokens`,
        response.status,
      ),
      status,
    );
  }
  return data.token;
}

export async function getGithubAppInstallation(
  installationId: number,
): Promise<GithubAppInstallation> {
  const data = await githubApi<{
    id: number;
    app_id: number;
    repository_selection: "all" | "selected";
    suspended_at?: string | null;
    account: {
      id: number;
      login: string;
      type: string;
    };
  }>(`/app/installations/${installationId}`, createGithubAppJwt());

  if (
    !Number.isFinite(data.id) ||
    !Number.isFinite(data.app_id) ||
    !Number.isFinite(data.account?.id) ||
    !data.account?.login
  ) {
    throw new GithubAppError("GitHub installation metadata is incomplete", 502);
  }

  return {
    id: data.id,
    appId: data.app_id,
    accountId: data.account.id,
    accountLogin: data.account.login,
    accountType: data.account.type,
    repositorySelection: data.repository_selection,
    suspended: Boolean(data.suspended_at),
  };
}

function mapRepository(repo: {
  id: number;
  full_name: string;
  name: string;
  private: boolean;
  html_url: string;
  created_at: string;
  size: number;
  owner: { login: string };
}): GithubInstallationRepository {
  return {
    id: repo.id,
    fullName: repo.full_name,
    name: repo.name,
    ownerLogin: repo.owner.login,
    private: repo.private,
    htmlUrl: repo.html_url,
    createdAt: repo.created_at,
    size: repo.size,
  };
}

export async function listGithubInstallationRepositories(
  installationId: number,
): Promise<GithubInstallationRepository[]> {
  const token = await getInstallationAccessToken(installationId);
  const repositories: GithubInstallationRepository[] = [];

  for (let page = 1; page <= 100; page++) {
    const data = await githubApi<{
      total_count: number;
      repositories: Array<{
        id: number;
        full_name: string;
        name: string;
        private: boolean;
        html_url: string;
        created_at: string;
        size: number;
        owner: { login: string };
      }>;
    }>(
      `/installation/repositories?per_page=100&page=${page}`,
      token,
    );
    const batch = data.repositories ?? [];
    repositories.push(...batch.map(mapRepository));
    if (
      batch.length < 100 ||
      repositories.length >= (data.total_count ?? repositories.length)
    ) {
      break;
    }
  }

  return repositories.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      a.fullName.localeCompare(b.fullName),
  );
}

/**
 * Resolve one repository using a token restricted to that repository.
 * GitHub rejects token creation when the repository is outside the installation.
 */
export async function getGithubInstallationRepository(
  installationId: number,
  repositoryId: number,
  options: { requireEmpty?: boolean } = {},
): Promise<GithubInstallationRepository> {
  const token = await getInstallationAccessToken(installationId, {
    repositoryIds: [repositoryId],
  });
  const repo = await githubApi<{
    id: number;
    full_name: string;
    name: string;
    private: boolean;
    html_url: string;
    created_at: string;
    size: number;
    owner: { login: string };
  }>(`/repositories/${repositoryId}`, token);
  if (repo.id !== repositoryId) {
    throw new GithubAppError("GitHub repository does not match selection", 403);
  }
  const mapped = mapRepository(repo);
  if (!options.requireEmpty) {
    return mapped;
  }
  if (mapped.size > 0) {
    throw new GithubAppError("只能连接没有任何 commit 的空仓库", 409);
  }

  const commitsPath = `/repos/${encodeURIComponent(mapped.ownerLogin)}/${encodeURIComponent(mapped.name)}/commits?per_page=1`;
  try {
    const commits = await githubApi<Array<{ sha: string }>>(commitsPath, token);
    if (commits.length === 0) {
      return mapped;
    }
  } catch (error) {
    if (
      error instanceof GithubAppError &&
      error.status === 409 &&
      /empty/i.test(error.message)
    ) {
      return mapped;
    }
    throw error;
  }
  throw new GithubAppError("只能连接没有任何 commit 的空仓库", 409);
}

/** True when GitHub signals that an App installation is gone or inaccessible. */
export function isGithubAppInstallMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const status = error instanceof GithubAppError ? error.status : 0;
  const message = error.message.toLowerCase();
  if (status === 404) {
    return true;
  }
  return (
    (status === 401 || status === 403) &&
    (message.includes("installation") ||
      message.includes("not found") ||
      message.includes("uninstalled") ||
      message.includes("suspended") ||
      message.includes("已卸载") ||
      message.includes("未安装"))
  );
}

export function buildGithubAppInstallUrl(input: {
  sessionId: string;
  userId: string | null;
  returnTo?: string;
}): string {
  if (!isGithubAppConfigured()) {
    throw new GithubAppError(
      "GitHub App is not configured (GITHUB_APP_ID / PRIVATE_KEY / INSTALL_URL)",
      503,
    );
  }

  const installUrl =
    getGithubAppInstallUrl() ??
    (getGithubAppSlug()
      ? `https://github.com/apps/${getGithubAppSlug()}/installations/new`
      : null);
  if (!installUrl) {
    throw new GithubAppError("GITHUB_APP_INSTALL_URL is not configured", 503);
  }

  const url = new URL(installUrl);
  url.searchParams.set(
    "state",
    buildGithubAppInstallState({
      sessionId: input.sessionId,
      userId: input.userId,
      returnTo: input.returnTo,
    }),
  );
  return url.toString();
}

export function getGithubInstallationSettingsUrl(
  installationId: number,
): string {
  return `https://github.com/settings/installations/${installationId}`;
}
