import type { SandboxMode } from "@/lib/sandbox/types";
import { isDaytonaFreePlan } from "@/lib/features/daytona-free-plan";

export function isFreestyleConfigured(): boolean {
  return Boolean(process.env.FREESTYLE_API_KEY?.trim());
}

/**
 * Product gate: Freestyle is SoT for every Vercel session, and for Daytona
 * unless DAYTONA_FREE_PLAN is on.
 */
export function shouldUseFreestyle(mode?: SandboxMode): boolean {
  if (mode === "vercel") {
    return isFreestyleConfigured();
  }
  return !isDaytonaFreePlan() && isFreestyleConfigured();
}

/**
 * Freestyle is the durable source of truth when not on Daytona free plan.
 * Vercel sessions always require Freestyle.
 */
export function assertFreestyleForDaytona(mode?: SandboxMode): void {
  if (mode === "vercel") {
    if (!isFreestyleConfigured()) {
      throw new Error(
        "FREESTYLE_API_KEY is required. Freestyle Git is the durable source of truth for Vercel sandbox sessions.",
      );
    }
    return;
  }
  if (isDaytonaFreePlan()) {
    return;
  }
  if (!isFreestyleConfigured()) {
    throw new Error(
      "FREESTYLE_API_KEY is required. Freestyle Git is the durable source of truth for Daytona sessions.",
    );
  }
}

export function getFreestyleApiKey(): string {
  const key = process.env.FREESTYLE_API_KEY?.trim();
  if (!key) {
    throw new Error("FREESTYLE_API_KEY is not configured");
  }
  return key;
}

export function freestyleRemoteUrl(repoId: string): string {
  return `https://git.freestyle.sh/${repoId}`;
}

/** Native Git username used with Freestyle identity tokens. */
export const FREESTYLE_GIT_USERNAME = "x-access-token";

export const GIT_AUTHOR_NAME = "baby-lovable";
export const GIT_AUTHOR_EMAIL = "agent@baby-lovable.local";

/** Soft retention days before Freestyle repo GC after session soft-delete. */
export function getFreestyleRepoRetentionDays(): number {
  const raw = process.env.FREESTYLE_REPO_RETENTION_DAYS?.trim();
  const parsed = raw ? Number(raw) : 30;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
}
