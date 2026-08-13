/** Per-platform-user GitHub App installation metadata. Contains no tokens. */
export interface GithubAppInstallationBinding {
  userId: string;
  installationId: number;
  githubAccountId: number;
  githubLogin: string;
  updatedAt: string;
}

export function normalizeGithubAppInstallationBinding(
  value: unknown,
): GithubAppInstallationBinding | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.userId !== "string" ||
    typeof raw.installationId !== "number" ||
    !Number.isSafeInteger(raw.installationId) ||
    raw.installationId <= 0 ||
    typeof raw.githubAccountId !== "number" ||
    !Number.isSafeInteger(raw.githubAccountId) ||
    raw.githubAccountId <= 0 ||
    typeof raw.githubLogin !== "string" ||
    !raw.githubLogin.trim()
  ) {
    return null;
  }
  return {
    userId: raw.userId,
    installationId: raw.installationId,
    githubAccountId: raw.githubAccountId,
    githubLogin: raw.githubLogin,
    updatedAt:
      typeof raw.updatedAt === "string"
        ? raw.updatedAt
        : new Date().toISOString(),
  };
}
