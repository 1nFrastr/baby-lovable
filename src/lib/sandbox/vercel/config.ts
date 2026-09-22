import { getDefaultDevPort } from "../config";

export const VERCEL_WORKSPACE_ROOT =
  process.env.VERCEL_WORKSPACE_ROOT ?? "/vercel/sandbox";

/** 1 vCPU → 2 GiB RAM (SDK: 2048 MB per vCPU). Disk is not configurable. */
export const VERCEL_DEFAULT_VCPUS = 1;

/**
 * Idle window, not a hard lifetime. Activity (agent tools, preview, reconcile)
 * tops remaining time back up to this window via `extendTimeout`.
 */
export const VERCEL_DEFAULT_IDLE_MINUTES = 15;

/** Skip extendTimeout when remaining time is still within this slack of idle. */
export const VERCEL_IDLE_EXTEND_SLACK_MS = 60_000;

export function getVercelDevPort(): number {
  return getDefaultDevPort();
}

export function getVercelVcpus(): number {
  const raw = process.env.VERCEL_SANDBOX_VCPUS?.trim();
  const parsed = raw ? Number(raw) : VERCEL_DEFAULT_VCPUS;
  if (!Number.isFinite(parsed) || parsed < 1) {
    return VERCEL_DEFAULT_VCPUS;
  }
  return Math.floor(parsed);
}

export function getVercelResources(): { vcpus: number } {
  return { vcpus: getVercelVcpus() };
}

export function getVercelIdleMs(): number {
  const raw =
    process.env.SANDBOX_IDLE_MINUTES ??
    process.env.VERCEL_SANDBOX_IDLE_MINUTES;
  if (raw === undefined || raw.trim() === "") {
    return VERCEL_DEFAULT_IDLE_MINUTES * 60 * 1000;
  }
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return VERCEL_DEFAULT_IDLE_MINUTES * 60 * 1000;
  }
  return minutes * 60 * 1000;
}

/**
 * How much to add via additive `extendTimeout` so remaining ≈ idle.
 * 0 = already has a full idle window (or expiry unknown — do not stack).
 */
export function vercelIdleExtendMs(input: {
  now?: number;
  idleMs: number;
  expiresAt?: Date | null;
  slackMs?: number;
}): number {
  const now = input.now ?? Date.now();
  const slack = input.slackMs ?? VERCEL_IDLE_EXTEND_SLACK_MS;
  if (!input.expiresAt) {
    return 0;
  }
  const remaining = input.expiresAt.getTime() - now;
  if (!Number.isFinite(remaining)) {
    return 0;
  }
  if (remaining >= input.idleMs - slack) {
    return 0;
  }
  return Math.max(0, Math.ceil(input.idleMs - remaining));
}

export function vercelSandboxName(sessionId: string): string {
  const slug = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return slug.slice(0, 64) || "session";
}

export const VERCEL_DEFAULT_IMAGE = "baby-lovable-nextjs-starter";

export function getVercelSnapshotId(): string | null {
  const id = process.env.VERCEL_SANDBOX_SNAPSHOT?.trim();
  return id || null;
}

export function getVercelSandboxImage(): string {
  return process.env.VERCEL_SANDBOX_IMAGE?.trim() || VERCEL_DEFAULT_IMAGE;
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
