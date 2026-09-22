import { getDefaultDevPort, getSandboxIdleMinutes } from "../config";

export const VERCEL_WORKSPACE_ROOT =
  process.env.VERCEL_WORKSPACE_ROOT ?? "/vercel/sandbox";

export function getVercelDevPort(): number {
  return getDefaultDevPort();
}

export function getVercelIdleMs(): number {
  const minutes = getSandboxIdleMinutes();
  if (minutes <= 0) {
    return 24 * 60 * 60 * 1000;
  }
  return minutes * 60 * 1000;
}

export function vercelSandboxName(sessionId: string): string {
  const slug = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return slug.slice(0, 64) || "session";
}

export function getVercelSnapshotId(): string | null {
  const id = process.env.VERCEL_SANDBOX_SNAPSHOT?.trim();
  return id || null;
}

export function getVercelSandboxImage(): string {
  return process.env.VERCEL_SANDBOX_IMAGE?.trim() || "vercel/sandbox/universal";
}

export function getVercelNetworkPolicy():
  | "allow-all"
  | { allow: string[] } {
  const fromEnv = process.env.VERCEL_SANDBOX_ALLOW_HOSTS?.trim();
  if (fromEnv === "*") {
    return "allow-all";
  }
  if (fromEnv) {
    return { allow: fromEnv.split(",").map((h) => h.trim()).filter(Boolean) };
  }
  return {
    allow: [
      "git.freestyle.sh",
      "api.freestyle.sh",
      "*.freestyle.sh",
      "github.com",
      "*.github.com",
      "*.githubusercontent.com",
      "registry.npmjs.org",
      "registry.npmjs.com",
      "nodejs.org",
      "*.vercel.run",
    ],
  };
}

export function isVercelSandboxConfigured(): boolean {
  if (process.env.VERCEL === "1") {
    return true;
  }
  if (process.env.VERCEL_OIDC_TOKEN?.trim()) {
    return true;
  }
  const token = process.env.VERCEL_TOKEN?.trim();
  const teamId =
    process.env.VERCEL_TEAM_ID?.trim() || process.env.VERCEL_ORG_ID?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  return Boolean(token && teamId && projectId);
}
