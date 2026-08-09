import { createPrivateKey, createSign, randomUUID } from "node:crypto";

import {
  getGithubAppCallbackUrl,
  getGithubAppClientId,
  getGithubAppClientSecret,
  getGithubAppId,
  getGithubAppInstallUrl,
  getGithubAppPrivateKey,
  getGithubAppSlug,
  isGithubAppConfigured,
} from "./app-config";
import { buildGithubAppOAuthState } from "./oauth-state";

export class GithubAppError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "GithubAppError";
    this.status = status;
  }
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** GitHub App JWT (RS256), valid ~10 minutes. */
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

export interface GithubUserAccessToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  tokenType: string;
}

async function exchangeOAuthForm(
  body: Record<string, string>,
): Promise<GithubUserAccessToken> {
  const clientId = getGithubAppClientId();
  const clientSecret = getGithubAppClientSecret();
  if (!clientId || !clientSecret) {
    throw new GithubAppError("GitHub App OAuth is not configured", 503);
  }

  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      ...body,
    }),
  });

  const data = (await response.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    error?: string;
    error_description?: string;
  } | null;

  if (!response.ok || !data?.access_token) {
    throw new GithubAppError(
      data?.error_description ??
        data?.error ??
        `GitHub OAuth token exchange failed (${response.status})`,
      502,
    );
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt:
      typeof data.expires_in === "number"
        ? Date.now() + data.expires_in * 1000
        : null,
    tokenType: data.token_type ?? "bearer",
  };
}

export async function exchangeGithubAppOAuthCode(
  code: string,
  options: { redirectUri?: string } = {},
): Promise<GithubUserAccessToken> {
  const body: Record<string, string> = { code };
  if (options.redirectUri) {
    // Must match the redirect_uri used in the authorize step when one was sent.
    body.redirect_uri = options.redirectUri;
  }
  return exchangeOAuthForm(body);
}

export async function refreshGithubAppUserToken(
  refreshToken: string,
): Promise<GithubUserAccessToken> {
  return exchangeOAuthForm({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function getInstallationAccessToken(
  installationId: number,
): Promise<string> {
  const jwt = createGithubAppJwt();
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  const data = (await response.json().catch(() => null)) as {
    token?: string;
    message?: string;
  } | null;
  if (!response.ok || !data?.token) {
    const status =
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404
        ? response.status
        : 502;
    throw new GithubAppError(
      data?.message ?? `Failed to mint installation token (${response.status})`,
      status,
    );
  }
  return data.token;
}

/** True when GitHub signals the App install is gone / inaccessible. */
export function isGithubAppInstallMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const status = error instanceof GithubAppError ? error.status : 0;
  const message = error.message.toLowerCase();
  // Only treat explicit installation-not-found style failures — not every 401
  // (e.g. bad JWT / rate limit) which would wipe a freshly written binding.
  if (status === 404) {
    return true;
  }
  if (
    message.includes("installation") &&
    (message.includes("not found") ||
      message.includes("suspended") ||
      message.includes("disabled") ||
      message.includes("uninstalled") ||
      message.includes("未安装") ||
      message.includes("已卸载"))
  ) {
    return true;
  }
  if (
    (status === 401 || status === 403) &&
    (message.includes("installation") ||
      message.includes("not found") ||
      message.includes("uninstalled") ||
      message.includes("已卸载") ||
      message.includes("未安装"))
  ) {
    return true;
  }
  return false;
}

/**
 * Find this platform App among the user's installations.
 * Returns null when the App is not installed (e.g. user uninstalled in GitHub UI).
 */
export async function findUserInstallationForApp(
  accessToken: string,
  appId: string = getGithubAppId() ?? "",
): Promise<{ id: number } | null> {
  if (!appId) {
    throw new GithubAppError("GITHUB_APP_ID is not configured", 503);
  }
  const data = await githubApi<{
    total_count?: number;
    installations?: Array<{ id: number; app_id: number }>;
  }>("/user/installations?per_page=100", accessToken);
  const match = (data.installations ?? []).find(
    (entry) => String(entry.app_id) === String(appId),
  );
  return match ? { id: match.id } : null;
}

/**
 * Prove the platform App is still installed for this user.
 * Prefers stored installationId; falls back to listing user installations.
 */
export async function assertGithubAppInstalledForUser(
  accessToken: string,
  installationId: number | null,
): Promise<number> {
  if (installationId != null && Number.isFinite(installationId)) {
    try {
      await getInstallationAccessToken(installationId);
      return installationId;
    } catch (error) {
      // Stale id after reinstall — always fall through to list.
      // Only rethrow hard failures that are clearly not "wrong installation".
      const status = error instanceof GithubAppError ? error.status : 0;
      if (status === 502 || status === 503) {
        throw error;
      }
      // Fall through — user may have reinstalled under a new installation id.
    }
  }

  const found = await findUserInstallationForApp(accessToken);
  if (!found) {
    throw new GithubAppError(
      "GitHub App 已卸载或未安装，请重新授权安装",
      401,
    );
  }
  return found.id;
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
      "X-GitHub-Api-Version": "2022-11-28",
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
    const status =
      response.status === 401 ||
      response.status === 403 ||
      response.status === 404 ||
      response.status === 422
        ? response.status
        : 502;
    throw new GithubAppError(formatGithubApiError(data, path, response.status), status);
  }
  return data as T;
}

export async function getGithubAuthenticatedUser(accessToken: string): Promise<{
  login: string;
  id: number;
}> {
  const user = await githubApi<{ login: string; id: number }>(
    "/user",
    accessToken,
  );
  if (!user.login) {
    throw new GithubAppError("GitHub user login missing", 502);
  }
  return { login: user.login, id: user.id };
}

export interface CreatedGithubRepo {
  fullName: string;
  name: string;
  ownerLogin: string;
  private: boolean;
  htmlUrl: string;
}

function mapGithubRepoPayload(repo: {
  full_name: string;
  name: string;
  private: boolean;
  html_url: string;
  owner: { login: string };
}): CreatedGithubRepo {
  return {
    fullName: repo.full_name,
    name: repo.name,
    ownerLogin: repo.owner.login,
    private: repo.private,
    htmlUrl: repo.html_url,
  };
}

export function sanitizeGithubRepoBaseName(baseName: string): string {
  return (
    baseName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || `baby-lovable-${randomUUID().slice(0, 8)}`
  );
}

/** GitHub often returns top-level "Repository creation failed." with details in errors[]. */
export function isGithubRepoNameTakenError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("already exists") ||
    message.includes("name already exists") ||
    (message.includes("repository creation failed") &&
      (message.includes("name") || message.includes("exists")))
  );
}

export async function getUserRepoIfExists(
  accessToken: string,
  ownerLogin: string,
  repoName: string,
): Promise<CreatedGithubRepo | null> {
  try {
    const repo = await githubApi<{
      full_name: string;
      name: string;
      private: boolean;
      html_url: string;
      owner: { login: string };
    }>(
      `/repos/${encodeURIComponent(ownerLogin)}/${encodeURIComponent(repoName)}`,
      accessToken,
    );
    return mapGithubRepoPayload(repo);
  } catch (error) {
    if (error instanceof GithubAppError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Create an empty private repository under the authenticated user.
 * Retries with numeric suffixes on name collision.
 * When `ownerLogin` is set and the base name already exists, reuses that repo
 * (disconnect → reconnect) instead of failing or always suffixing.
 */
export async function createEmptyUserRepo(
  accessToken: string,
  baseName: string,
  options: { maxAttempts?: number; ownerLogin?: string } = {},
): Promise<CreatedGithubRepo> {
  const maxAttempts = options.maxAttempts ?? 8;
  const sanitized = sanitizeGithubRepoBaseName(baseName);
  const ownerLogin = options.ownerLogin?.trim() || null;

  if (ownerLogin) {
    const existing = await getUserRepoIfExists(
      accessToken,
      ownerLogin,
      sanitized,
    );
    if (existing) {
      return existing;
    }
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const name = attempt === 0 ? sanitized : `${sanitized}-${attempt + 1}`;
    try {
      const repo = await githubApi<{
        full_name: string;
        name: string;
        private: boolean;
        html_url: string;
        owner: { login: string };
      }>("/user/repos", accessToken, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          private: true,
          auto_init: false,
          description: "Created by baby-lovable GitHub Sync",
        }),
      });
      return mapGithubRepoPayload(repo);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const nameTaken = isGithubRepoNameTakenError(lastError);
      const maybeTaken =
        nameTaken ||
        (error instanceof GithubAppError &&
          error.status === 422 &&
          error.message.toLowerCase().includes("repository creation failed"));

      if (!maybeTaken) {
        throw lastError;
      }

      // Prefer reusing the conflicting name (disconnect → reconnect) over suffixing.
      if (ownerLogin) {
        const existing = await getUserRepoIfExists(
          accessToken,
          ownerLogin,
          name,
        );
        if (existing) {
          return existing;
        }
      }
    }
  }
  throw lastError ?? new GithubAppError("创建 GitHub 仓库失败", 502);
}

/**
 * Build authorize / reinstall URL.
 *
 * Default `intent: "install"` uses `/apps/<slug>/installations/new` so uninstall →
 * re-auth actually reinstalls the App (pure OAuth alone does not). GitHub ignores
 * `redirect_uri` on that path and uses the App's first Callback URL.
 *
 * `intent: "oauth"` uses the web application flow with an explicit `redirect_uri`
 * (honored for local vs prod multi-callback). Use when the App is already installed
 * and only a fresh user token is needed.
 */
export function buildGithubAppAuthorizeUrl(input: {
  sessionId: string;
  userId: string;
  returnTo?: string;
  requestOrigin?: string;
  /** @default "install" */
  intent?: "install" | "oauth";
}): string {
  if (!isGithubAppConfigured()) {
    throw new GithubAppError(
      "GitHub App is not configured (GITHUB_APP_ID / PRIVATE_KEY / CLIENT_ID / SECRET)",
      503,
    );
  }

  const intent = input.intent ?? "install";
  const redirectUri =
    intent === "oauth"
      ? getGithubAppCallbackUrl(input.requestOrigin)
      : undefined;

  const state = buildGithubAppOAuthState({
    sessionId: input.sessionId,
    userId: input.userId,
    returnTo: input.returnTo,
    intent,
    redirectUri,
  });

  if (intent === "install") {
    const installUrl =
      getGithubAppInstallUrl() ??
      (getGithubAppSlug()
        ? `https://github.com/apps/${getGithubAppSlug()}/installations/new`
        : null);
    if (installUrl) {
      const url = new URL(installUrl);
      url.searchParams.set("state", state);
      return url.toString();
    }
  }

  const clientId = getGithubAppClientId();
  if (!clientId) {
    throw new GithubAppError("GITHUB_APP_CLIENT_ID is not configured", 503);
  }

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("state", state);
  url.searchParams.set(
    "redirect_uri",
    redirectUri ?? getGithubAppCallbackUrl(input.requestOrigin),
  );
  return url.toString();
}
