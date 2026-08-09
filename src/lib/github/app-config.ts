/**
 * Platform GitHub App credentials for user OAuth + empty-repo creation.
 * Same App must be bound in Freestyle Dashboard → Git > Sync.
 */

function trimEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

/** Normalize PEM that may use literal `\n` escapes in env files. */
export function normalizePrivateKeyPem(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.includes("-----BEGIN")) {
    return trimmed.replace(/\\n/g, "\n");
  }
  // Base64-encoded PEM body without headers (rare); wrap as PKCS#8.
  const decoded = Buffer.from(trimmed, "base64").toString("utf8");
  if (decoded.includes("-----BEGIN")) {
    return decoded;
  }
  return trimmed.replace(/\\n/g, "\n");
}

export function getGithubAppId(): string | null {
  return trimEnv("GITHUB_APP_ID") ?? null;
}

export function getGithubAppPrivateKey(): string | null {
  const raw = trimEnv("GITHUB_APP_PRIVATE_KEY");
  return raw ? normalizePrivateKeyPem(raw) : null;
}

export function getGithubAppClientId(): string | null {
  return trimEnv("GITHUB_APP_CLIENT_ID") ?? null;
}

export function getGithubAppClientSecret(): string | null {
  return trimEnv("GITHUB_APP_CLIENT_SECRET") ?? null;
}

/**
 * GitHub App installation URL (Freestyle Dashboard → Git > Sync, or App settings).
 * Example: https://github.com/apps/<slug>/installations/new
 */
export function getGithubAppInstallUrl(): string | null {
  return trimEnv("GITHUB_APP_INSTALL_URL") ?? null;
}

/** App slug for assembling install / OAuth URLs when install URL is unset. */
export function getGithubAppSlug(): string | null {
  const explicit = trimEnv("GITHUB_APP_SLUG");
  if (explicit) {
    return explicit;
  }
  const installUrl = getGithubAppInstallUrl();
  if (!installUrl) {
    return null;
  }
  const match = installUrl.match(/github\.com\/apps\/([^/]+)/i);
  return match?.[1] ?? null;
}

export function isGithubAppConfigured(): boolean {
  return Boolean(
    getGithubAppId() &&
      getGithubAppPrivateKey() &&
      getGithubAppClientId() &&
      getGithubAppClientSecret(),
  );
}

/**
 * Public origin for OAuth callback / success redirects.
 * Prefer the incoming request host; otherwise VERCEL_URL, then localhost.
 */
export function getPublicAppOrigin(requestOrigin?: string): string {
  if (requestOrigin) {
    return requestOrigin.replace(/\/+$/, "");
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL.replace(/\/+$/, "")}`;
  }
  return "http://localhost:3000";
}

export function getGithubAppCallbackPath(): string {
  return "/api/github/app/callback";
}

/** Absolute Callback URL for the current app origin (must match App settings). */
export function getGithubAppCallbackUrl(requestOrigin?: string): string {
  return `${getPublicAppOrigin(requestOrigin)}${getGithubAppCallbackPath()}`;
}
