/** Per-user GitHub App OAuth / installation binding. */

export interface GithubAppUserBinding {
  userId: string;
  githubLogin: string;
  installationId: number | null;
  userAccessToken: string;
  refreshToken: string | null;
  /** Unix ms when access token expires; null if unknown/non-expiring. */
  expiresAt: number | null;
  updatedAt: string;
}

export function normalizeGithubAppUserBinding(
  value: unknown,
): GithubAppUserBinding | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.userId !== "string" ||
    typeof raw.githubLogin !== "string" ||
    typeof raw.userAccessToken !== "string"
  ) {
    return null;
  }
  return {
    userId: raw.userId,
    githubLogin: raw.githubLogin,
    installationId:
      typeof raw.installationId === "number" ? raw.installationId : null,
    userAccessToken: raw.userAccessToken,
    refreshToken:
      typeof raw.refreshToken === "string" ? raw.refreshToken : null,
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : null,
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : new Date().toISOString(),
  };
}

/** True when access token is missing or within 2 minutes of expiry. */
export function isGithubAccessTokenExpired(
  binding: GithubAppUserBinding,
  skewMs = 2 * 60 * 1000,
): boolean {
  if (!binding.userAccessToken) {
    return true;
  }
  if (binding.expiresAt == null) {
    return false;
  }
  return Date.now() >= binding.expiresAt - skewMs;
}
